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

import contextlib
import json
import os
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

from filelock import FileLock, Timeout as _LockTimeout

from app.core.config import settings
from app.core.logging import get_logger
from app.services.ffmpeg import ffmpeg

# Caption-timing + audio-assembly are engine-agnostic — shared with the Piper
# (system-voice) engine. The underscore aliases keep this module's call sites and
# the tests that reach for ``fish_clone._align_to_text`` / ``_MAX_WORD_DUR``
# working unchanged.
from app.services.storyvault.narration_align import (
    BEAT_GAP as _BEAT_GAP,
    MAX_WORD_DUR as _MAX_WORD_DUR,
    align_to_text as _align_to_text,
    apply_tempo as _apply_tempo,
    concat_with_gaps as _concat_with_gaps,
    offset as _offset,
    probe_duration as _probe_duration,
    whisper_words as _whisper_words,
)

if TYPE_CHECKING:
    from app.services.storyvault.tts import NarrationResult, StoryNarration

logger = get_logger(__name__)

# s2-pro GGUF quantizations, smallest → largest (q4_k_m is a good CPU default).
QUANTS = ["q2_k", "q3_k", "q4_k_m", "q5_k_m", "q6_k", "q8_0", "f16"]
DEFAULT_QUANT = "q4_k_m"
_SETTINGS_FILE = Path(settings.DATA_DIR) / "fish-clone-settings.json"


class FishCloneError(RuntimeError):
    """Raised when the Fish Speech server is unreachable or synthesis fails."""


class _Transient(Exception):
    """A retryable synthesis failure (server busy / dropped connection)."""


# The s2.cpp server synthesizes exactly ONE request at a time and 503s ("Server
# busy processing another synthesis request") anything that arrives mid-render —
# it also sometimes just drops the connection under that contention. Both Celery
# prefork workers AND the API process (the /voices/clone/generate endpoint) can
# reach it, so an in-process lock is not enough: serialize every /generate call
# through a cross-process advisory file lock under DATA_DIR. A single synthesis
# can run for minutes, so a queued caller may wait a long time for the lock — the
# timeout is generous and is a hard ceiling, not the expected wait.
_SYNTH_LOCK_FILE = str(Path(settings.DATA_DIR) / "fish-synthesis.lock")
_SYNTH_LOCK = FileLock(_SYNTH_LOCK_FILE)
_LOCK_TIMEOUT = float(getattr(settings, "FISH_LOCK_TIMEOUT_S", 3600.0))
_HTTP_TIMEOUT = 1800
_SYNTH_RETRIES = max(1, int(getattr(settings, "FISH_SYNTH_RETRIES", 3)))


@contextlib.contextmanager
def _synthesis_lock():
    """Serialize access to the single-threaded s2 server across processes/threads."""
    try:
        with _SYNTH_LOCK.acquire(timeout=_LOCK_TIMEOUT):
            yield
    except _LockTimeout as exc:
        raise FishCloneError(
            "Timed out waiting for the Fish Speech server to free up — another "
            "narration is still synthesizing. Try again once it finishes."
        ) from exc


def _post_generate(body: bytes, boundary: str) -> bytes:
    """POST one multipart synthesis request, classifying retryable failures."""
    req = urllib.request.Request(
        f"{server_url()}/generate",
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        # The s2 server sends headers only AFTER synthesis (no streaming here),
        # which on CPU can take minutes — keep the socket timeout generous.
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:  # noqa: S310 (loopback only)
            return resp.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        with contextlib.suppress(Exception):
            detail = exc.read().decode("utf-8", "replace")[:200].strip()
        msg = f"Fish synthesis failed (HTTP {exc.code}{': ' + detail if detail else ''})."
        # 503 = the engine is mid-synthesis for someone else; worth a retry.
        raise (_Transient if exc.code == 503 else FishCloneError)(msg) from exc
    except (urllib.error.URLError, OSError) as exc:
        # A dropped/closed connection ("Remote end closed connection without
        # response") is the other face of contention — retry it too.
        raise _Transient(f"Fish synthesis failed ({exc}). Server {server_url()}.") from exc
    except Exception as exc:
        raise FishCloneError(f"Fish synthesis failed ({exc}). Server {server_url()}.") from exc


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
    logger.info(
        "Fish clone synth: %d chars%s -> %s",
        len(text), " (cloned)" if ref_bytes else "", out_wav,
    )
    # Hold the cross-process lock for the whole request so two callers never hit
    # the single-threaded engine at once. A 503/dropped connection inside the
    # lock means an *unlocked* caller is racing us — back off and retry.
    audio = b""
    with _synthesis_lock():
        for attempt in range(1, _SYNTH_RETRIES + 1):
            try:
                audio = _post_generate(body, boundary)
                break
            except _Transient as exc:
                if attempt >= _SYNTH_RETRIES:
                    raise FishCloneError(str(exc)) from exc
                backoff = min(5.0 * attempt, 20.0)
                logger.warning(
                    "Fish synth transient failure (attempt %d/%d): %s — retrying in %.0fs",
                    attempt, _SYNTH_RETRIES, exc, backoff,
                )
                time.sleep(backoff)

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
# engine returns only a WAV, so the timing + audio-assembly steps are the shared,
# engine-agnostic helpers in :mod:`narration_align` (imported above as the
# ``_``-prefixed names): whisper supplies *timing* only, the caption text stays
# the known script, and exact beat windows come from synthesizing each beat on its
# own and measuring it. This mirrors what :mod:`tts` produces for SAPI, so the
# downstream caption + overlay code is identical for every engine.


def narrate(
    text: str,
    out_wav: str,
    *,
    ref_path: str | None = None,
    prompt_text: str | None = None,
    speed: float = 1.0,
) -> NarrationResult:
    """Body-only narration in the cloned voice, with word-synced caption timings.

    The SAPI counterpart is :func:`tts.synthesize`; this returns the same
    :class:`tts.NarrationResult` so the caption pipeline is engine-agnostic.
    """
    from app.services.storyvault.tts import NarrationResult, speechify_acronyms

    # Acronyms are spelled out for the *voice* only ("AITA" -> "A I T A"); the
    # caption text stays the original script below.
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
) -> StoryNarration:
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
            # Spell acronyms for the voice only; the body caption text
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
