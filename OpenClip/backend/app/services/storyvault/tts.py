"""Narration synthesis via Windows SAPI (System.Speech, no extra installs).

Spawns PowerShell with :file:`sapi_tts.ps1`, which writes a WAV plus a JSON
word-boundary timing track (SpeakProgress events), giving captions exact
per-word sync. Voices ship with Windows (David, Zira, …).
"""
from __future__ import annotations

import json
import os
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

        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
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


def _build_words(raw: list[dict[str, Any]], total: float) -> list[dict[str, Any]]:
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

    words: list[dict[str, Any]] = []
    for i, d in enumerate(deduped):
        start = max(0.0, d["audioMs"] / 1000.0)
        if i + 1 < len(deduped):
            nxt = max(start, deduped[i + 1]["audioMs"] / 1000.0)
            end = min(nxt, start + 1.5) if nxt > start else start + 0.3
        else:
            end = min(total or start + _LAST_WORD_TAIL, start + _LAST_WORD_TAIL) or (start + _LAST_WORD_TAIL)
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
    raw, duration = _run_sapi(text, wav_path, voice=voice, speed=speed)
    words = _build_words(raw, duration) or _even_spacing(text, duration)
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
    combined, ranges = _assemble(parts)
    if not combined.strip() or not ranges:
        raise TTSError("No narration text")
    raw, duration = _run_sapi(combined, wav_path, voice=voice, speed=speed)
    words = _build_words(raw, duration) or _even_spacing(combined, duration)
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
