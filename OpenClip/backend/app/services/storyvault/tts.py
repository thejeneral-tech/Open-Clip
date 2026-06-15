"""Narration synthesis via Windows SAPI (System.Speech, no extra installs).

Spawns PowerShell with :file:`sapi_tts.ps1`, which writes a WAV plus a JSON
word-boundary timing track (SpeakProgress events), giving captions exact
per-word sync. Voices ship with Windows (David, Zira, …).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Any

from app.core.logging import get_logger
from app.services.ffmpeg import ffmpeg

logger = get_logger(__name__)

_SCRIPT = os.path.join(os.path.dirname(__file__), "sapi_tts.ps1")
_LAST_WORD_TAIL = 0.45  # seconds the final word is held on screen

# Silence detection used to anchor captions to where speech *actually* is in the
# rendered WAV (SAPI's reported clock drifts — see ``_calibrate``).
_SILENCE_NOISE_DB = -35     # below this RMS counts as silence
_SILENCE_MIN_DUR = 0.18     # shorter dips (stop consonants) are not pauses
_PIN_SLACK = 0.4            # tolerance when checking a clause break straddles a pause


class TTSError(RuntimeError):
    pass


@dataclass
class NarrationResult:
    wav_path: str
    duration: float
    voice: str | None
    # Caption tokens: [{"word", "start", "end"}, ...] (seconds, audio-relative)
    words: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class StoryNarration:
    """A narration that reads the title (topic card) and the author intro before
    the story body — all on one audio timeline.

    Carries the body-only caption tokens (the title/author are shown by the intro
    overlays, never captioned) plus each intro beat's on-screen window, so the
    cards stay up for exactly as long as their line is spoken and the body
    captions begin precisely when the body narration does.
    """

    wav_path: str
    duration: float
    voice: str | None
    body_words: list[dict[str, Any]] = field(default_factory=list)
    body_start: float = 0.0
    # (start, end) seconds, or None when that beat isn't narrated. The topic card
    # holds from the very start of the video until the author/body voice begins.
    card_window: tuple[float, float] | None = None
    author_window: tuple[float, float] | None = None


def _powershell() -> list[str]:
    return ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]


def speed_to_rate(speed: float) -> int:
    """Map the UI speed slider (0.7–1.4, 1.0 = normal) onto SAPI rate −10…10."""
    speed = max(0.7, min(1.4, float(speed or 1.0)))
    return int(round((speed - 1.0) * 10))


# How a TTS voice should pronounce each letter when an acronym is spelled out.
# Two strategies, chosen per engine (see ``speechify_acronyms``):
#   * Windows SAPI reads a *bare* spaced letter ("W I B T A") by name, including
#     the tricky vowels A ("ay") and I ("eye") — verified by transcribing its
#     output. Phonetic spellings are actually worse there: SAPI voices the word
#     "ay" as /aɪ/, so "AITA" → "ay eye tee ay" comes back sounding like "AITI".
#   * Cloned/neural voices instead mangle bare letters, so they get the phonetic
#     spellings below, which they read syllable-by-syllable.
_LETTER_SOUNDS = {
    "A": "ay", "B": "bee", "C": "see", "D": "dee", "E": "ee", "F": "eff",
    "G": "jee", "H": "aitch", "I": "eye", "J": "jay", "K": "kay", "L": "el",
    "M": "em", "N": "en", "O": "oh", "P": "pee", "Q": "cue", "R": "arr",
    "S": "ess", "T": "tee", "U": "you", "V": "vee", "W": "double-you",
    "X": "ex", "Y": "why", "Z": "zee",
}

# Candidate token: a whole-word run of 2–6 uppercase ASCII letters (AITA, WIBTA,
# OP, …). 7+ runs are left alone — far more likely a shouted word than an
# initialism. Whether a candidate is *actually* spelled is decided by
# :func:`_should_spell`.
_ACRONYM_RE = re.compile(r"\b[A-Z]{2,6}\b")
_VOWELS = frozenset("AEIOUY")

# Always spell these — centred on the AITA/relationships stories this app pulls,
# plus common internet initialisms. Vowel-containing acronyms must be listed
# here; the vowel-less heuristic below cannot recognise them.
_KNOWN_ACRONYMS = frozenset(
    {
        "AITA", "AITAH", "WIBTA", "WIBTAH", "YTA", "NTA", "ESH", "NAH",
        "YWBTA", "YWNBTA", "TIFU", "OP", "OOP", "MIL", "FIL", "SIL", "BIL", "DIL",
        "IMO", "IMHO", "FYI", "AFAIK", "IIRC", "ETA", "ASAP", "FWIW", "IDK", "TMI",
        "IRL", "AKA", "NSFW", "PTSD", "OCD", "ADHD", "CPS", "CEO", "CFO", "COO",
    }
)
# Vowel-less tokens that are NOT acronyms — keep the vowel-less rule from spelling
# them (they read fine as the words/titles the engine already expands).
_NON_ACRONYMS = frozenset(
    {"MR", "MRS", "DR", "ST", "MS", "HMM", "HMMM", "SHH", "PSST", "GRR",
     "BRR", "TSK", "MM", "HM", "NTH"}
)


def _should_spell(word: str) -> bool:
    """True if an all-caps token should be read letter-by-letter.

    Conservative on purpose: a writer's CAPS *emphasis* ("I said NO", "he NEVER
    called") must not be spelled out. Every common emphasis word contains a
    vowel, so an unknown token is spelled only when it's a vowel-less initialism
    (BF, DH, TV…); vowel-containing acronyms come from the curated allowlist.
    """
    if word in _NON_ACRONYMS:
        return False
    if word in _KNOWN_ACRONYMS:
        return True
    return not (_VOWELS & frozenset(word))


def speechify_acronyms(text: str, *, letters: bool = True) -> str:
    """Spell recognised acronyms so the voice reads them letter-by-letter.

    Rewrites only the *spoken* text; captions keep the original acronym (the body
    caption text is the untouched script, aligned to the audio downstream).
    ``letters=True`` (Windows SAPI) emits bare spaced letters ("W I B T A");
    ``letters=False`` (cloned/neural voices) emits the phonetic spellings.
    Emphasis words and non-acronyms are left untouched (see :func:`_should_spell`).
    """
    def _repl(m):
        word = m.group(0)
        if not _should_spell(word):
            return word
        return " ".join(word) if letters else " ".join(_LETTER_SOUNDS[c] for c in word)

    return _ACRONYM_RE.sub(_repl, text)


def list_voices() -> list[dict[str, str]]:
    """Installed SAPI voices (name, culture, gender)."""
    if sys.platform != "win32":
        return []
    ps = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "$v = $s.GetInstalledVoices() | ForEach-Object { $i = $_.VoiceInfo; "
        "[pscustomobject]@{ name = $i.Name; culture = $i.Culture.Name; gender = [string]$i.Gender } }; "
        "ConvertTo-Json -Compress -InputObject @($v)"
    )
    try:
        out = subprocess.run(
            [*_powershell(), "-Command", ps],
            capture_output=True, text=True, timeout=30, check=True,
        )
        data = json.loads(out.stdout.strip() or "[]")
        if isinstance(data, dict):
            data = [data]
        return [d for d in data if d and d.get("name")]
    except Exception as exc:
        logger.warning("Could not list SAPI voices: %s", exc)
        return []


def _run_sapi(
    text: str, wav_path: str, *, voice: str | None, speed: float
) -> tuple[list[dict[str, Any]], float]:
    """Speak ``text`` to ``wav_path``; return the raw SAPI word-boundary events
    and the audio duration.

    Each raw event carries ``word`` / ``audioMs`` / ``charPos`` / ``charCount``
    (the engine's own map back into the source ``text``), which the callers use
    to de-duplicate repeated boundaries and to split a multi-beat narration.
    """
    if sys.platform != "win32":
        raise TTSError("SAPI narration requires Windows (System.Speech)")
    os.makedirs(os.path.dirname(wav_path), exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="sv_tts_") as tmp:
        text_file = os.path.join(tmp, "text.txt")
        timings_file = os.path.join(tmp, "timings.json")
        with open(text_file, "w", encoding="utf-8") as fh:
            fh.write(text)

        cmd = [
            *_powershell(), "-File", _SCRIPT,
            "-TextFile", text_file,
            "-Out", wav_path,
            "-Rate", str(speed_to_rate(speed)),
            "-TimingsOut", timings_file,
        ]
        if voice:
            cmd.extend(["-Voice", voice])

        # Scale the timeout with the script length: a 30-minute narration is far
        # longer than the old fixed 10-minute cap allowed. Estimate the spoken
        # duration (~2.2 words/sec) and give SAPI ~2× that plus a fixed margin.
        words = len(text.split())
        est_audio = words / 2.2
        timeout = max(600, int(est_audio * 2.0) + 120)
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if proc.returncode != 0 or not os.path.exists(wav_path):
            raise TTSError(
                f"SAPI synthesis failed (rc={proc.returncode}): "
                f"{(proc.stderr or proc.stdout or '').strip()[:400]}"
            )

        raw: list[dict[str, Any]] = []
        try:
            with open(timings_file, encoding="utf-8-sig") as fh:
                raw = json.load(fh) or []
        except Exception as exc:
            logger.warning("No SAPI word timings (%s); captions fall back to even spacing", exc)

    duration = 0.0
    try:
        duration = ffmpeg.probe(wav_path).duration
    except Exception as exc:
        logger.warning("Could not probe narration duration: %s", exc)
    return raw, duration


def _detect_silences(wav_path: str) -> list[tuple[float, float]]:
    """Silence intervals ``[(start, end), ...]`` in the rendered WAV, in order.

    Uses ffmpeg's ``silencedetect`` so captions can be pinned to where speech
    actually is, not where SAPI *says* it is (its clock drifts — see
    :func:`_calibrate`). Best-effort: any failure (no ffmpeg, missing file)
    returns ``[]`` and the caller falls back to raw-duration calibration.
    """
    if not wav_path or not os.path.exists(wav_path):
        return []
    try:
        proc = subprocess.run(
            [ffmpeg.bin, "-hide_banner", "-nostats", "-i", wav_path,
             "-af", f"silencedetect=noise={_SILENCE_NOISE_DB}dB:d={_SILENCE_MIN_DUR}",
             "-f", "null", "-"],
            capture_output=True, text=True, timeout=120,
        )
    except Exception as exc:  # pragma: no cover - environment dependent
        logger.warning("silencedetect failed (%s); using raw-duration calibration", exc)
        return []
    out = proc.stderr or ""
    starts = [float(m) for m in re.findall(r"silence_start:\s*([0-9.]+)", out)]
    ends = [float(m) for m in re.findall(r"silence_end:\s*([0-9.]+)", out)]
    return list(zip(starts, ends))


def _speech_bounds(
    silences: list[tuple[float, float]], total: float
) -> tuple[float, float, list[tuple[float, float]]]:
    """Resolve detected silences into ``(speech_start, speech_end, pauses)``.

    A silence touching the start of the file is the lead-in (its end is the
    speech onset); one touching the end is the trailing pad (its start is where
    speech stops); everything between is an internal pause (a sentence/beat
    boundary). A run that flags more than half the clip as silent is implausible
    (a too-hot noise floor) and is discarded — the caller then anchors on the raw
    duration, exactly as with no detection at all.
    """
    speech_start, speech_end = 0.0, total
    pauses: list[tuple[float, float]] = []
    for s, e in silences:
        if s <= 0.05:
            speech_start = max(speech_start, e)
        elif e >= total - 0.05:
            speech_end = min(speech_end, s)
        else:
            pauses.append((s, e))
    if total <= 0 or speech_end - speech_start < 0.5 * total:
        return 0.0, total, []
    return speech_start, speech_end, pauses


def _piecewise(
    R: list[float], bounds: list[int], runs: list[tuple[float, float]]
) -> list[float]:
    """Distribute reported word starts ``R`` across the real speech ``runs``.

    ``bounds[k]`` is the index of the last word in run ``k`` (the clause break
    after it); ``runs[k] = (start, end)`` is that run's real on-audio window.
    Within a run the words keep their reported relative spacing, and the run's
    last word is left ending at the run end — its highlight then naturally holds
    across the following pause downstream. The result is exact at every run
    start, so sentence/beat openings land precisely on the voice.
    """
    n = len(R)
    out = [0.0] * n
    lo = 0
    for k, (rs, re) in enumerate(runs):
        hi = bounds[k] if k < len(bounds) else n - 1  # inclusive last index
        idx = list(range(lo, hi + 1))
        lo = hi + 1
        if not idx:
            continue
        if len(idx) == 1:
            out[idx[0]] = rs
            continue
        gaps = [R[idx[j + 1]] - R[idx[j]] for j in range(len(idx) - 1)]
        typ = sorted(gaps)[len(gaps) // 2]               # median reported word gap
        r_first, r_end = R[idx[0]], R[idx[-1]] + max(typ, 1e-3)
        denom = r_end - r_first
        for j in idx:
            frac = (R[j] - r_first) / denom if denom > 0 else 0.0
            out[j] = rs + frac * (re - rs)
    return out


def _calibrate(
    deduped: list[dict[str, Any]],
    total: float,
    silences: list[tuple[float, float]],
) -> float:
    """Map SAPI's reported word positions onto where speech actually is.

    SAPI's ``SpeakProgress.AudioPosition`` clock runs measurably ahead of the
    audio it writes to the WAV — on this engine ~20-25% fast, so a 10s clip's
    last word is reported near 12.2s. Because the render trims the video to the
    real audio duration, those over-reported words land past the end and their
    captions are **cut off** (the voice says them, the highlight never arrives);
    every earlier word also drifts progressively late off the spoken word.

    Two stages, the second refining the first:

    * **Envelope-linear (always):** the drift is very nearly linear in true audio
      time, so a single linear map — first word to the speech onset, last word
      ending at the speech offset (from :func:`_speech_bounds`) — removes the
      bulk drift *and* the leading/trailing silence the raw duration wrongly
      included. Only ever compresses an over-running clock; a no-op when the
      clock already fits and no pauses were detected (well-behaved engines and
      the even-spacing fallback are untouched).
    * **Run-pinning (when the pause structure is unambiguous):** each spoken run
      between detected pauses is pinned to its real silence-bounded window, so
      sentence/beat starts land exactly on the voice. Each detected pause is
      matched to the reported inter-word gap that brackets it (by position, in
      the envelope-mapped timeline — *not* by size, since a multi-syllable word
      like "47" → "forty-seven" can open a within-clause gap wider than a real
      boundary). Used only when every break then straddles its pause — otherwise
      the envelope map stands.

    Returns ``speech_end`` so the caller can hold the final word to the true end
    of speech rather than into the trailing silence. ``charPos`` / ``charCount``
    are left untouched, so the multi-beat split still keys off the source map.
    """
    speech_start, speech_end, pauses = _speech_bounds(silences, total)
    n = len(deduped)
    if n < 2 or total <= 0:
        return speech_end
    R = [float(d["audioMs"]) / 1000.0 for d in deduped]
    r0, rN = R[0], R[-1]
    span = rN - r0
    target = speech_end - _LAST_WORD_TAIL - speech_start
    if span <= 0 or target <= 0:
        return speech_end

    k = target / span
    if k >= 1.0 and not pauses:  # clock already fits and nothing to pin
        return speech_end
    k = min(k, 1.0)
    result = [speech_start + (r - r0) * k for r in R]  # stage 1: envelope-linear

    # Stage 2: pin spoken runs between real pauses.
    if pauses and len(pauses) < n:
        m = len(pauses)
        # Match each pause to the reported gap that brackets it: the break is the
        # last word whose envelope-mapped start falls before the pause midpoint
        # (the next word is then the first one spoken after the pause). Scanning
        # left-to-right keeps the breaks strictly ordered, one gap per pause.
        bounds: list[int] = []
        lo = 0
        for s, e in pauses:
            mid = (s + e) / 2
            cand = -1
            for i in range(lo, n - 1):  # i+1 must exist, so stop at n-2
                if result[i] <= mid:
                    cand = i
                else:
                    break  # result is monotonic — no later word can qualify
            if cand < 0:
                break
            bounds.append(cand)
            lo = cand + 1
        runs: list[tuple[float, float]] = []
        prev = speech_start
        for s, e in pauses:
            runs.append((prev, s))
            prev = e
        runs.append((prev, speech_end))
        straddles = len(bounds) == m and all(
            result[bounds[i]] <= pauses[i][1] + _PIN_SLACK
            and result[bounds[i] + 1] >= pauses[i][0] - _PIN_SLACK
            for i in range(m)
        )
        if straddles and all(re > rs for rs, re in runs):
            result = _piecewise(R, bounds, runs)

    prev_t = -1.0
    for d, t in zip(deduped, result):
        t = max(0.0, t, prev_t + 1e-3)  # strictly monotonic, never negative
        d["audioMs"] = t * 1000.0
        prev_t = t
    return speech_end


def _build_words(
    raw: list[dict[str, Any]],
    total: float,
    silences: list[tuple[float, float]] | None = None,
) -> list[dict[str, Any]]:
    """Caption tokens from raw SAPI word-boundary events, de-duplicated.

    SAPI raises one SpeakProgress event per *spoken* word, but a single written
    token can be voiced as several words — "34" → "thirty four", "Dr." →
    "doctor", "2010" → "twenty ten". Each spoken word reports the SAME source
    span (``charPos`` / ``charCount``), so ``$e.Text`` repeats ("34", "34") and
    burned straight into captions that becomes the doubled word/number artifact
    ("34 34"). Here we collapse a run of events that point at one source span
    into a single token spanning the whole run, so the word is shown once and
    stays lit while the voice finishes saying it. This keys off the engine's own
    character map, not the rendered phonemes, so it holds for every SAPI voice
    with no per-voice tuning. ``charPos`` / ``charCount`` are kept so a multi-beat
    narration can be split back into its title / author / body parts.

    The de-duplicated positions are then calibrated onto the real audio timeline
    (:func:`_calibrate`, using the detected ``silences``) so the highlight tracks
    the voice end-to-end.
    """
    deduped: list[dict[str, Any]] = []
    for t in raw:
        text = str(t.get("word") or "").strip()
        if not text:
            continue
        cp, cc = t.get("charPos"), t.get("charCount")
        if (
            deduped
            and isinstance(cc, int) and cc > 0
            and deduped[-1]["charPos"] == cp
            and deduped[-1]["charCount"] == cc
        ):
            continue  # same written token re-reported — already captured
        deduped.append(
            {"word": text, "audioMs": float(t.get("audioMs") or 0), "charPos": cp, "charCount": cc}
        )

    speech_end = _calibrate(deduped, total, silences or [])

    words: list[dict[str, Any]] = []
    for i, d in enumerate(deduped):
        start = max(0.0, d["audioMs"] / 1000.0)
        if i + 1 < len(deduped):
            nxt = max(start, deduped[i + 1]["audioMs"] / 1000.0)
            end = min(nxt, start + 1.5) if nxt > start else start + 0.3
        else:
            # Hold the final word to the true end of speech, not into the
            # trailing silence (which the raw duration would have included).
            end = min(speech_end or start + _LAST_WORD_TAIL, start + _LAST_WORD_TAIL) or (start + _LAST_WORD_TAIL)
        if end <= start:
            end = start + 0.2
        words.append(
            {"word": d["word"], "start": round(start, 3), "end": round(end, 3),
             "charPos": d["charPos"], "charCount": d["charCount"]}
        )
    return words


def _even_spacing(text: str, duration: float) -> list[dict[str, Any]]:
    """Last-resort tokens when SAPI returned no timings: space the words evenly
    across the audio so captions still render (no source char positions)."""
    toks = [w for w in text.split() if w.strip()]
    if not toks or duration <= 0:
        return []
    step = duration / len(toks)
    return [
        {"word": w, "start": round(i * step, 3), "end": round((i + 1) * step, 3),
         "charPos": None, "charCount": None}
        for i, w in enumerate(toks)
    ]


def _clean_words(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop the internal char-position bookkeeping from caption tokens."""
    return [{"word": w["word"], "start": w["start"], "end": w["end"]} for w in words]


def synthesize(
    text: str,
    wav_path: str,
    *,
    voice: str | None = None,
    speed: float = 1.0,
) -> NarrationResult:
    """Synthesize ``text`` to ``wav_path`` and return real word timings."""
    text = speechify_acronyms(text)  # read acronyms letter by letter (SAPI: bare letters)
    raw, duration = _run_sapi(text, wav_path, voice=voice, speed=speed)
    words = _build_words(raw, duration, _detect_silences(wav_path)) or _even_spacing(text, duration)
    if not duration and words:
        duration = words[-1]["end"]
    return NarrationResult(
        wav_path=wav_path, duration=duration, voice=voice, words=_clean_words(words)
    )


# ----------------------------------------------------- multi-beat story narration
def _assemble(parts: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Join the intro/body parts into one utterance, tracking each part's
    character range (and word count) in the combined text.

    A blank line between parts gives SAPI a sentence-boundary pause so the beats
    don't run together, and the recorded ranges let :func:`_split_by_kind` map
    the resulting word timings back to the part that produced them.
    """
    sep = "\n\n"
    chunks: list[str] = []
    ranges: list[dict[str, Any]] = []
    cursor = 0
    for part in parts:
        text = (part.get("text") or "").strip()
        if not text:
            continue
        if chunks:
            chunks.append(sep)
            cursor += len(sep)
        start = cursor
        chunks.append(text)
        cursor += len(text)
        ranges.append(
            {"kind": part["kind"], "start_char": start, "end_char": cursor,
             "word_count": len(text.split())}
        )
    return "".join(chunks), ranges


def _split_by_kind(
    words: list[dict[str, Any]], ranges: list[dict[str, Any]]
) -> dict[str, list[dict[str, Any]]]:
    """Group word tokens by beat.

    Uses each token's source ``charPos`` when the engine supplied it (the
    reliable path — every word maps to the part whose character range contains
    it), and falls back to splitting on the parts' word counts in order when no
    char map is available (the even-spacing fallback).
    """
    out: dict[str, list[dict[str, Any]]] = {r["kind"]: [] for r in ranges}
    have_pos = sum(1 for w in words if isinstance(w.get("charPos"), int) and w["charPos"] >= 0)
    if words and have_pos >= 0.8 * len(words):
        for w in words:
            cp = w["charPos"]
            kind = ranges[0]["kind"]
            for r in ranges:  # ranges are ordered; take the last one starting at/before cp
                if r["start_char"] <= cp:
                    kind = r["kind"]
                else:
                    break
            out[kind].append(w)
    else:
        i = 0
        for j, r in enumerate(ranges):
            chunk = words[i:] if j == len(ranges) - 1 else words[i : i + r["word_count"]]
            out[r["kind"]] = chunk
            i += r["word_count"]
    return out


def synthesize_story(
    parts: list[dict[str, Any]],
    wav_path: str,
    *,
    voice: str | None = None,
    speed: float = 1.0,
) -> StoryNarration:
    """Narrate an intro sequence then the body as one continuous audio track.

    ``parts`` is an ordered list of ``{"kind", "text"}`` with kinds ``"card"``
    (the title, shown on the topic card), ``"author"`` (the "Posted by …" line),
    and ``"body"`` — only the beats present are spoken. Everything is synthesized
    in one pass (one clean timeline, no concatenation seams), then the word
    timings are split back per beat so the cards can be shown for exactly as long
    as their line is read and the body captions begin precisely when the body
    narration does.
    """
    # Spell acronyms per beat before assembling, so the recorded char ranges
    # (which drive the per-beat caption split) stay aligned with the spoken text.
    parts = [{**p, "text": speechify_acronyms(p.get("text") or "")} for p in parts]
    combined, ranges = _assemble(parts)
    if not combined.strip() or not ranges:
        raise TTSError("No narration text")
    raw, duration = _run_sapi(combined, wav_path, voice=voice, speed=speed)
    words = _build_words(raw, duration, _detect_silences(wav_path)) or _even_spacing(combined, duration)
    if not duration and words:
        duration = words[-1]["end"]

    grouped = _split_by_kind(words, ranges)
    body_words = grouped.get("body") or []
    card_words = grouped.get("card") or []
    author_words = grouped.get("author") or []

    body_start = body_words[0]["start"] if body_words else duration
    author_start = author_words[0]["start"] if author_words else None
    # The card holds from the very start until the next beat's voice begins.
    card_window = (
        (0.0, author_start if author_start is not None else body_start) if card_words else None
    )
    author_window = (author_start, body_start) if author_start is not None else None

    return StoryNarration(
        wav_path=wav_path,
        duration=duration,
        voice=voice,
        body_words=_clean_words(body_words),
        body_start=round(body_start, 3),
        card_window=(round(card_window[0], 3), round(card_window[1], 3)) if card_window else None,
        author_window=(
            (round(author_window[0], 3), round(author_window[1], 3)) if author_window else None
        ),
    )
