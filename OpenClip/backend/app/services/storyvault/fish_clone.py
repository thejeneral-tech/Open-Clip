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

import json
import os
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from app.core.config import settings
from app.core.logging import get_logger
from app.services.ffmpeg import ffmpeg

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
