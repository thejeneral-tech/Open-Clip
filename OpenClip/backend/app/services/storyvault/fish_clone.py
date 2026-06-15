"""Voice cloning via Fish Speech S2 (s2.cpp HTTP server).

The s2.cpp engine runs as a persistent ``s2 --server`` process that loads the
GGUF model once and exposes a single multipart endpoint, ``POST /generate``.
Given target ``text`` plus an optional reference clip + its transcript, it
synthesizes speech in the reference voice. See the s2.cpp OpenAPI spec for the
field contract; unknown ``params`` keys are ignored for forward-compatibility.

This module is a thin, synchronous client (called via ``run_in_threadpool``):
it builds the multipart body by hand (stdlib only) and writes the returned WAV.
"""
from __future__ import annotations

import difflib
import json
import os
import re
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

from app.core.config import settings
from app.core.logging import get_logger
from app.services.ffmpeg import ffmpeg

if TYPE_CHECKING:
    from app.services.storyvault.tts import NarrationResult, StoryNarration

logger = get_logger(__name__)

# s2-pro GGUF quantizations, smallest → largest (q4_k_m is a good CPU default).
QUANTS = ["q2_k", "q3_k", "q4_k_m", "q5_k_m", "q6_k", "q8_0", "f16"]
DEFAULT_QUANT = "q4_k_m"
_SETTINGS_FILE = Path(settings.DATA_DIR) / "fish-clone-settings.json"


class FishCloneError(RuntimeError):
    """Raised when the Fish Speech server is unreachable or synthesis fails."""


def server_url() -> str:
    return (settings.FISH_TTS_URL or "http://127.0.0.1:8080").rstrip("/")


def model_dir() -> str:
    return settings.FISH_MODEL_DIR or ""


def _load_settings() -> dict:
    try:
        return json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def get_quant() -> str:
    q = _load_settings().get("quant")
    return q if q in QUANTS else DEFAULT_QUANT


def set_quant(quant: str) -> str:
    """Persist the preferred GGUF quant. Raises ValueError on an unknown quant."""
    if quant not in QUANTS:
        raise ValueError(f"Unknown quant {quant!r}. Choose one of: {', '.join(QUANTS)}")
    try:
        _SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        _SETTINGS_FILE.write_text(json.dumps({"quant": quant}), encoding="utf-8")
    except Exception as exc:  # pragma: no cover - disk error
        logger.warning("Could not persist fish quant: %s", exc)
    return quant


def list_present_quants() -> list[str]:
    """Which quants are actually downloaded in the model folder (by filename)."""
    d = model_dir()
    if not d or not os.path.isdir(d):
        return []
    try:
        files = {f.lower() for f in os.listdir(d)}
    except OSError:
        return []
    return [q for q in QUANTS if f"s2-pro-{q}.gguf".lower() in files]


def reachable(timeout: float = 2.0) -> bool:
    """A response at all (even 404) means the socket is bound and the model is
    loaded — the s2 server binds only after the weights are ready."""
    try:
        urllib.request.urlopen(server_url(), timeout=timeout)  # noqa: S310 (loopback only)
        return True
    except urllib.error.HTTPError:
        return True  # bound and answering, just not on "/"
    except Exception:
        return False


def _encode_multipart(
    boundary: str,
    *,
    text: str,
    params: dict,
    ref_bytes: bytes | None,
    ref_name: str | None,
    ref_text: str | None,
) -> bytes:
    crlf = b"\r\n"
    b = boundary.encode()
    chunks: list[bytes] = []

    def field(name: str, value: str) -> None:
        chunks.append(b"--" + b + crlf)
        chunks.append(f'Content-Disposition: form-data; name="{name}"'.encode() + crlf + crlf)
        chunks.append(value.encode("utf-8") + crlf)

    field("text", text)
    field("params", json.dumps(params))
    if ref_bytes is not None:
        chunks.append(b"--" + b + crlf)
        chunks.append(
            f'Content-Disposition: form-data; name="reference"; filename="{ref_name or "reference.wav"}"'.encode()
            + crlf
        )
        chunks.append(b"Content-Type: application/octet-stream" + crlf + crlf)
        chunks.append(ref_bytes + crlf)
        field("reference_text", ref_text or "")
    chunks.append(b"--" + b + b"--" + crlf)
    return b"".join(chunks)


def synthesize(
    text: str,
    out_wav: str,
    *,
    ref_path: str | None = None,
    prompt_text: str | None = None,
    temperature: float | None = None,
) -> float:
    """Synthesize ``text`` to ``out_wav`` in the reference voice. Returns the
    audio duration in seconds.

    Cloning needs a reference clip AND its transcript; if a reference is given
    without a transcript the engine 400s, so we degrade to plain synthesis.
    """
    text = (text or "").strip()
    if not text:
        raise FishCloneError("Enter the text you want spoken.")

    ref_bytes: bytes | None = None
    ref_name: str | None = None
    prompt = (prompt_text or "").strip()
    if ref_path and prompt:
        try:
            with open(ref_path, "rb") as fh:
                ref_bytes = fh.read()
            ref_name = "reference.wav"
        except OSError as exc:
            logger.warning("Voice clone reference unreadable (%s) — synthesizing without it", exc)
            ref_bytes = None
    elif ref_path and not prompt:
        logger.warning("Reference clip given without a transcript — synthesizing without the voice reference.")

    if not reachable():
        raise FishCloneError(
            f"Fish Speech server is not reachable at {server_url()}. "
            "Start the s2.cpp server (the StoryVault launcher → Fish Speech → Start Server)."
        )

    params = {
        "temperature": float(temperature if temperature is not None else settings.FISH_TEMPERATURE),
        "top_p": 0.8,
        "top_k": 30,
        "max_new_tokens": int(settings.FISH_MAX_TOKENS),
        "segment_sentences": True,
        "segment_max_chars": 240,
        "sentence_pause_ms": 180,
    }
    boundary = "----openclips2" + uuid.uuid4().hex
    body = _encode_multipart(
        boundary,
        text=text,
        params=params,
        ref_bytes=ref_bytes,
        ref_name=ref_name,
        ref_text=prompt,
    )
    req = urllib.request.Request(
        f"{server_url()}/generate",
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    logger.info(
        "Fish clone synth: %d chars%s -> %s",
        len(text), " (cloned)" if ref_bytes else "", out_wav,
    )
    try:
        # The s2 server sends headers only AFTER synthesis (no streaming here),
        # which on CPU can take minutes — keep the socket timeout generous.
        with urllib.request.urlopen(req, timeout=1800) as resp:  # noqa: S310 (loopback only)
            audio = resp.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:200].strip()
        except Exception:
            pass
        raise FishCloneError(f"Fish synthesis failed (HTTP {exc.code}{': ' + detail if detail else ''}).") from exc
    except Exception as exc:
        raise FishCloneError(f"Fish synthesis failed ({exc}). Server {server_url()}.") from exc

    if not audio or len(audio) < 256:
        raise FishCloneError("Fish synthesis returned an unexpectedly small audio response.")
    with open(out_wav, "wb") as fh:
        fh.write(audio)

    try:
        return float(ffmpeg.probe(out_wav).duration)
    except Exception:
        return 0.0


# ===================================================================== narration
# The video pipeline needs more than a raw clip: word-synced caption timings, and
# (for stories with an intro) the on-screen window of each intro beat. The s2
# engine returns neither — only a WAV — so we recover word *timings* by aligning
# the rendered speech with faster-whisper (the same engine the app already uses
# for transcription). Crucially, only whisper's timing is used: the caption text
# stays the known script (see :func:`_align_to_text`), so a mis-recognised word
# never reaches the screen. Exact beat windows come from synthesizing each beat on
# its own and measuring it. This mirrors what :mod:`tts` produces for SAPI, so the
# downstream caption + overlay code is identical for both engines.
_BEAT_GAP = 0.18  # seconds of silence between intro beats (matches the SAPI feel)


def _probe_duration(wav_path: str) -> float:
    try:
        return float(ffmpeg.probe(wav_path).duration)
    except Exception:
        return 0.0


def _apply_tempo(wav_path: str, speed: float) -> None:
    """Time-stretch ``wav_path`` in place to honour a preset's speed (the s2 engine
    has no rate control of its own). A no-op at 1.0; clamped to atempo's 0.5–2.0."""
    if abs((speed or 1.0) - 1.0) < 0.01:
        return
    tempo = max(0.5, min(2.0, float(speed)))
    tmp = wav_path + ".tempo.wav"
    ffmpeg.run(["-i", wav_path, "-filter:a", f"atempo={tempo:.3f}",
                "-ac", "1", "-c:a", "pcm_s16le", tmp])
    os.replace(tmp, wav_path)


def _concat_with_gaps(wavs: list[str], out_wav: str, *, gap: float = _BEAT_GAP, sr: int = 24000) -> None:
    """Concatenate ``wavs`` into ``out_wav``, separated by ``gap`` s of silence.

    Each segment (and the generated silence) is normalized to mono ``sr`` first so
    clips of differing sample rate / channel layout join cleanly.
    """
    inputs: list[str] = []
    for w in wavs:
        inputs += ["-i", w]
    fmt = f"aformat=sample_fmts=s16:sample_rates={sr}:channel_layouts=mono"
    parts: list[str] = []
    labels: list[str] = []
    for i in range(len(wavs)):
        parts.append(f"[{i}:a]{fmt}[a{i}]")
        labels.append(f"[a{i}]")
        if i < len(wavs) - 1:
            parts.append(f"anullsrc=r={sr}:cl=mono:d={gap},{fmt}[g{i}]")
            labels.append(f"[g{i}]")
    graph = ";".join(parts) + ";" + "".join(labels) + f"concat=n={len(labels)}:v=0:a=1[out]"
    ffmpeg.run([*inputs, "-filter_complex", graph, "-map", "[out]",
                "-ac", "1", "-ar", str(sr), "-c:a", "pcm_s16le", out_wav])


def _whisper_words(wav_path: str) -> list[dict]:
    """Recognised word tokens ``[{word, start, end}]`` for a synthesized clip, from
    faster-whisper. These supply *timing* only — :func:`_align_to_text` maps the
    known script text onto them. Best-effort: ``[]`` on any failure, so the caller
    falls back to even spacing exactly as the SAPI path does."""
    try:
        from app.services.transcription import transcribe

        result = transcribe(wav_path)
    except Exception as exc:
        logger.warning("Whisper alignment of cloned narration failed (%s); captions fall back to even spacing", exc)
        return []
    words: list[dict] = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            word = str(w.get("word") or "").strip()
            if not word:
                continue
            start = max(0.0, float(w.get("start") or 0.0))
            end = max(start, float(w.get("end") or start))
            words.append({"word": word, "start": round(start, 3), "end": round(end, 3)})
    return words


def _offset(words: list[dict], by: float) -> list[dict]:
    return [
        {"word": w["word"], "start": round(w["start"] + by, 3), "end": round(w["end"] + by, 3)}
        for w in words
    ]


_ALNUM = re.compile(r"[^a-z0-9]+")
# A single caption word never holds on screen longer than this. Per-beat
# alignment keeps words sub-second; the cap only bites if whisper hallucinates or
# duplicates so badly that an unmatched word ends up bracketed by a far-away
# anchor — then the highlight is bounded instead of stalling for seconds. Mirrors
# the per-word duration cap on the SAPI path (:func:`tts._build_words`).
_MAX_WORD_DUR = 2.5


def _norm(word: str) -> str:
    """Alignment key for a token: lowercased, punctuation/spacing stripped."""
    return _ALNUM.sub("", word.lower())


def _spread(words: list[dict], lo: int, hi: int, t0: float, t1: float) -> None:
    """Time the unanchored tokens ``words[lo:hi]`` across ``[t0, t1]`` in place.

    Script words whisper failed to recognise get no timestamp of their own; we
    fill them between their surrounding anchors, giving longer words proportionally
    more time so the highlight still glides at a natural pace.
    """
    if hi <= lo:
        return
    t1 = max(t1, t0)
    weights = [max(1, len(words[i]["word"])) for i in range(lo, hi)]
    total = sum(weights) or 1
    span = t1 - t0
    cursor = t0
    for off, i in enumerate(range(lo, hi)):
        nxt = cursor + span * weights[off] / total
        words[i]["start"] = cursor
        words[i]["end"] = nxt
        cursor = nxt


def _align_to_text(text: str, whisper_words: list[dict], duration: float) -> list[dict]:
    """Caption tokens showing the *known* script text, timed from the whisper words.

    Whisper transcribes the *synthesized* speech, so its word **text** drifts from
    the script — mishearings, merged words, numbers spelled out — and burning that
    straight in is the "slurred / wrong-lettering" caption bug. Here whisper is
    used only for **timing**: the script's own words are the caption text, each
    timestamped from the whisper word it aligns to, with any unmatched word
    interpolated between its neighbours. The displayed letters are therefore
    always exactly the script, however the recogniser heard the audio.

    Falls back to even spacing of the script when whisper returned nothing (or
    nothing that aligns), so captions still read correctly.
    """
    from app.services.storyvault.tts import _even_spacing

    display = [w for w in text.split() if w.strip()]
    if not display:
        return []

    def _even() -> list[dict]:
        return [
            {"word": w["word"], "start": w["start"], "end": w["end"]}
            for w in _even_spacing(text, duration)
        ]

    if not whisper_words:
        return _even()

    a = [_norm(w) for w in display]
    b = [_norm(w["word"]) for w in whisper_words]
    out: list[dict] = [{"word": w, "start": None, "end": None} for w in display]

    # 1) Anchor every script word whisper recognised verbatim to that word's
    # measured (start, end). SequenceMatcher's equal blocks are the run-length
    # matches between the script tokens and the recognised tokens.
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    anchors: list[int] = []
    for ai, bj, size in sm.get_matching_blocks():
        for k in range(size):
            ww = whisper_words[bj + k]
            out[ai + k]["start"] = float(ww["start"])
            out[ai + k]["end"] = float(ww["end"])
            anchors.append(ai + k)

    if not anchors:
        # Whisper heard something entirely different — no reliable timing to map.
        return _even()

    # 2) Fill the gaps around the anchors: the leading run, each internal run, and
    # the trailing run, each spread across the time between its bracketing anchors.
    end_t = max(duration, out[anchors[-1]]["end"])
    _spread(out, 0, anchors[0], 0.0, out[anchors[0]]["start"])
    for p, q in zip(anchors, anchors[1:]):
        _spread(out, p + 1, q, out[p]["end"], out[q]["start"])
    _spread(out, anchors[-1] + 1, len(out), out[anchors[-1]]["end"], end_t)

    # 3) Clean, non-zero-length tokens (the caption layer owns final ordering).
    clean: list[dict] = []
    prev = 0.0
    for w in out:
        s = max(0.0, float(w["start"] if w["start"] is not None else prev))
        e = float(w["end"] if w["end"] is not None else s)
        if e <= s:
            e = s + 0.06
        e = min(e, s + _MAX_WORD_DUR)  # never let a word stall on screen
        clean.append({"word": w["word"], "start": round(s, 3), "end": round(e, 3)})
        prev = e
    return clean


def narrate(
    text: str,
    out_wav: str,
    *,
    ref_path: str | None = None,
    prompt_text: str | None = None,
    speed: float = 1.0,
) -> "NarrationResult":
    """Body-only narration in the cloned voice, with word-synced caption timings.

    The SAPI counterpart is :func:`tts.synthesize`; this returns the same
    :class:`tts.NarrationResult` so the caption pipeline is engine-agnostic.
    """
    from app.services.storyvault.tts import NarrationResult, speechify_acronyms

    # Acronyms are spelled out phonetically for the *voice* only ("AITA" ->
    # "ay eye tee ay"); the caption text stays the original script below.
    synthesize(speechify_acronyms(text), out_wav, ref_path=ref_path, prompt_text=prompt_text)
    _apply_tempo(out_wav, speed)
    duration = _probe_duration(out_wav)
    # Whisper supplies only the *timing*; the caption text is the known script, so
    # a mis-recognised word never reaches the screen (see :func:`_align_to_text`).
    words = _align_to_text(text, _whisper_words(out_wav), duration)
    if not duration and words:
        duration = words[-1]["end"]
    return NarrationResult(wav_path=out_wav, duration=duration, voice="fish-clone", words=words)


def narrate_story(
    parts: list[dict],
    out_wav: str,
    *,
    ref_path: str | None = None,
    prompt_text: str | None = None,
    speed: float = 1.0,
) -> "StoryNarration":
    """Intro-sequence + body narration in the cloned voice.

    Each present beat (``card`` / ``author`` / ``body``) is synthesized on its own
    so its exact on-screen window is known, then the beats are joined with a short
    pause into one track. Only the body is captioned, so only the body beat is
    whisper-aligned (then shifted onto the combined timeline). Mirrors
    :func:`tts.synthesize_story`.
    """
    from app.services.storyvault.tts import StoryNarration, speechify_acronyms

    present = [p for p in parts if (p.get("text") or "").strip()]
    if not present:
        raise FishCloneError("No narration text")

    workdir = os.path.dirname(out_wav) or "."
    os.makedirs(workdir, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="fish_beats_", dir=workdir) as tmp:
        ordered: list[tuple[str, str]] = []  # (kind, wav)
        durations: dict[str, float] = {}
        for idx, p in enumerate(present):
            beat_wav = os.path.join(tmp, f"beat{idx}.wav")
            # Spell acronyms phonetically for the voice only; the body caption text
            # (``body_text`` below) stays the original script.
            synthesize(speechify_acronyms(p["text"].strip()), beat_wav, ref_path=ref_path, prompt_text=prompt_text)
            _apply_tempo(beat_wav, speed)
            ordered.append((p["kind"], beat_wav))
            durations[p["kind"]] = _probe_duration(beat_wav)

        _concat_with_gaps([w for _, w in ordered], out_wav)
        duration = _probe_duration(out_wav)

        # Per-beat start offsets on the combined timeline (a gap follows each beat
        # except the last), so the intro cards hold for exactly their spoken line.
        starts: dict[str, float] = {}
        offset = 0.0
        for i, (kind, _) in enumerate(ordered):
            starts[kind] = offset
            offset += durations.get(kind, 0.0)
            if i < len(ordered) - 1:
                offset += _BEAT_GAP

        body_start = starts.get("body", duration)
        author_start = starts.get("author")
        body_wav = next((w for k, w in ordered if k == "body"), None)
        body_text = next((p["text"] for p in present if p["kind"] == "body"), "")
        # Caption the known body text, timed by aligning it to the recognised
        # words (whisper's text is discarded — only its timing is trusted).
        raw = _align_to_text(
            body_text, _whisper_words(body_wav) if body_wav else [], durations.get("body", 0.0)
        )
        body_words = _offset(raw, body_start)

    card_window = (
        (0.0, author_start if author_start is not None else body_start) if "card" in starts else None
    )
    author_window = (author_start, body_start) if author_start is not None else None

    return StoryNarration(
        wav_path=out_wav,
        duration=duration,
        voice="fish-clone",
        body_words=body_words,
        body_start=round(body_start, 3),
        card_window=(round(card_window[0], 3), round(card_window[1], 3)) if card_window else None,
        author_window=(
            (round(author_window[0], 3), round(author_window[1], 3)) if author_window else None
        ),
    )
