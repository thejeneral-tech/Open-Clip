"""Local neural "system voices" via Piper (the Linux/macOS counterpart to SAPI).

Windows narration uses SAPI (:mod:`tts`); that engine doesn't exist off Windows,
so on Linux/macOS the *System voices* are provided by Piper — a fast, offline
neural TTS. Voices are ``.onnx`` models (+ a sibling ``.onnx.json``) downloaded by
the launcher into ``settings.PIPER_VOICES_DIR``.

Piper is invoked as a subprocess (``piper -m <model>.onnx -f out.wav`` reading the
line from stdin); it returns only a WAV, so — exactly like the Fish clone engine —
word-synced caption timings are recovered via :mod:`narration_align` (whisper for
*timing* only; the caption text stays the known script). Speed is applied
post-hoc with ffmpeg ``atempo`` rather than Piper's ``length_scale``, so the same
helper serves every engine and we don't depend on a particular Piper CLI flag.

This module mirrors :mod:`tts`'s public API (:func:`synthesize`,
:func:`synthesize_story`, :func:`list_voices`) so the narration worker routes to
it with the same ``{voice, speed}`` kwargs it uses for SAPI.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.core.config import settings
from app.core.logging import get_logger
from app.services.storyvault.narration_align import (
    align_to_text,
    apply_tempo,
    concat_with_gaps,
    offset as offset_words,
    probe_duration,
    whisper_words,
)

if TYPE_CHECKING:
    from app.services.storyvault.tts import NarrationResult, StoryNarration

logger = get_logger(__name__)

_BEAT_GAP = 0.18  # match the SAPI/Fish inter-beat feel


class PiperError(RuntimeError):
    """Raised when Piper is not installed/usable or synthesis fails."""


def voices_dir() -> Path:
    return Path(settings.PIPER_VOICES_DIR)


def _piper_cmd() -> list[str]:
    """How to invoke Piper. Prefer an explicit/`which`-resolvable binary, else run
    the pip-installed package via the current interpreter (``python -m piper``)."""
    bin_ = (settings.PIPER_BIN or "").strip()
    if bin_ and (os.path.isfile(bin_) or shutil.which(bin_)):
        return [bin_]
    return [sys.executable, "-m", "piper"]


def installed() -> bool:
    """True if Piper is importable/runnable in this environment."""
    bin_ = (settings.PIPER_BIN or "").strip()
    if bin_ and (os.path.isfile(bin_) or shutil.which(bin_)):
        return True
    try:
        import importlib.util

        return importlib.util.find_spec("piper") is not None
    except Exception:
        return False


# --------------------------------------------------------------------- voices
def _voice_files() -> list[Path]:
    """Installed ``.onnx`` models that also have their ``.onnx.json`` config."""
    d = voices_dir()
    try:
        onnx = sorted(p for p in d.glob("*.onnx") if p.is_file())
    except OSError:
        return []
    return [p for p in onnx if p.with_suffix(p.suffix + ".json").exists()]


def _culture(model: Path) -> str | None:
    """Read the language code (e.g. ``en_US``) from the voice's ``.onnx.json``."""
    try:
        meta = json.loads(model.with_suffix(model.suffix + ".json").read_text(encoding="utf-8"))
    except Exception:
        return None
    lang = meta.get("language") or {}
    if isinstance(lang, dict):
        return lang.get("code") or lang.get("name_native") or None
    return str(lang) or None


def list_voices() -> list[dict[str, str]]:
    """Installed Piper voices in the same ``{name, culture, gender}`` shape the SAPI
    path returns, so the *System voices* dropdown group fills with no UI change.

    ``name`` is the voice id (the model filename stem, e.g. ``en_US-amy-medium``);
    it is stored verbatim as the video's voice and resolved back to its model by
    :func:`_resolve_model`.
    """
    out: list[dict[str, str]] = []
    for model in _voice_files():
        out.append({"name": model.stem, "culture": _culture(model), "gender": None})
    return out


def _resolve_model(voice: str | None) -> Path:
    """Resolve a voice id to its ``.onnx`` model, falling back to the configured
    default and then to any installed voice. Raises if none are installed."""
    files = _voice_files()
    if not files:
        raise PiperError(
            "No Piper voices are installed. Add one with "
            "`python launch.py voices --add en_US-amy-medium` (or run setup)."
        )
    by_stem = {p.stem: p for p in files}
    for cand in (voice, settings.PIPER_DEFAULT_VOICE):
        if cand and cand in by_stem:
            return by_stem[cand]
    if voice:
        logger.warning("Piper voice %r not installed; using %s", voice, files[0].stem)
    return files[0]


# ----------------------------------------------------------------- synthesis
def _run_piper(text: str, out_wav: str, *, voice: str | None) -> None:
    """Synthesize one line of ``text`` to ``out_wav`` with the given Piper voice."""
    text = " ".join((text or "").split())  # one utterance: collapse newlines/spaces
    if not text:
        raise PiperError("Nothing to speak.")
    model = _resolve_model(voice)
    os.makedirs(os.path.dirname(out_wav) or ".", exist_ok=True)

    cmd = [*_piper_cmd(), "-m", str(model), "-f", out_wav]
    if (settings.PIPER_DEVICE or "cpu").strip().lower() == "cuda":
        cmd.append("--cuda")

    words = len(text.split())
    timeout = max(300, int(words / 2.2 * 2.0) + 120)
    try:
        proc = subprocess.run(
            cmd, input=text, capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError as exc:
        raise PiperError(
            "Piper isn't installed in this environment. Run setup, or "
            "`pip install piper-tts` in the backend venv."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise PiperError(f"Piper synthesis timed out after {timeout}s.") from exc
    if proc.returncode != 0 or not os.path.exists(out_wav):
        raise PiperError(
            f"Piper synthesis failed (rc={proc.returncode}): "
            f"{(proc.stderr or proc.stdout or '').strip()[:400]}"
        )


def synthesize(
    text: str,
    wav_path: str,
    *,
    voice: str | None = None,
    speed: float = 1.0,
) -> NarrationResult:
    """Body-only narration in a Piper voice, with word-synced caption timings.

    The SAPI counterpart is :func:`tts.synthesize`; this returns the same
    :class:`tts.NarrationResult` so the caption pipeline is engine-agnostic.
    """
    from app.services.storyvault.tts import NarrationResult, speechify_acronyms

    # Acronyms are spelled out for the *voice* only; the caption text below stays
    # the original script.
    _run_piper(speechify_acronyms(text), wav_path, voice=voice)
    apply_tempo(wav_path, speed)
    duration = probe_duration(wav_path)
    words = align_to_text(text, whisper_words(wav_path), duration)
    if not duration and words:
        duration = words[-1]["end"]
    return NarrationResult(wav_path=wav_path, duration=duration, voice=voice, words=words)


def synthesize_story(
    parts: list[dict[str, Any]],
    wav_path: str,
    *,
    voice: str | None = None,
    speed: float = 1.0,
) -> StoryNarration:
    """Intro-sequence + body narration in a Piper voice.

    Each present beat (``card`` / ``author`` / ``body``) is synthesized on its own
    so its exact on-screen window is known, then the beats are joined with a short
    pause. Only the body is captioned. Mirrors :func:`tts.synthesize_story` and
    :func:`fish_clone.narrate_story`.
    """
    import tempfile

    from app.services.storyvault.tts import StoryNarration, speechify_acronyms

    present = [p for p in parts if (p.get("text") or "").strip()]
    if not present:
        raise PiperError("No narration text")

    workdir = os.path.dirname(wav_path) or "."
    os.makedirs(workdir, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="piper_beats_", dir=workdir) as tmp:
        ordered: list[tuple[str, str]] = []  # (kind, wav)
        durations: dict[str, float] = {}
        for idx, p in enumerate(present):
            beat_wav = os.path.join(tmp, f"beat{idx}.wav")
            _run_piper(speechify_acronyms(p["text"].strip()), beat_wav, voice=voice)
            apply_tempo(beat_wav, speed)
            ordered.append((p["kind"], beat_wav))
            durations[p["kind"]] = probe_duration(beat_wav)

        concat_with_gaps([w for _, w in ordered], wav_path)
        duration = probe_duration(wav_path)

        starts: dict[str, float] = {}
        cursor = 0.0
        for i, (kind, _) in enumerate(ordered):
            starts[kind] = cursor
            cursor += durations.get(kind, 0.0)
            if i < len(ordered) - 1:
                cursor += _BEAT_GAP

        body_start = starts.get("body", duration)
        author_start = starts.get("author")
        body_wav = next((w for k, w in ordered if k == "body"), None)
        body_text = next((p["text"] for p in present if p["kind"] == "body"), "")
        raw = align_to_text(
            body_text, whisper_words(body_wav) if body_wav else [], durations.get("body", 0.0)
        )
        body_words = offset_words(raw, body_start)

    card_window = (
        (0.0, author_start if author_start is not None else body_start) if "card" in starts else None
    )
    author_window = (author_start, body_start) if author_start is not None else None

    return StoryNarration(
        wav_path=wav_path,
        duration=duration,
        voice=voice,
        body_words=body_words,
        body_start=round(body_start, 3),
        card_window=(round(card_window[0], 3), round(card_window[1], 3)) if card_window else None,
        author_window=(
            (round(author_window[0], 3), round(author_window[1], 3)) if author_window else None
        ),
    )
