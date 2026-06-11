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


def _timings_to_words(raw: list[dict[str, Any]], total: float) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    for i, t in enumerate(raw):
        text = str(t.get("word") or "").strip()
        if not text:
            continue
        start = max(0.0, float(t.get("audioMs") or 0) / 1000.0)
        if i + 1 < len(raw):
            nxt = max(start, float(raw[i + 1].get("audioMs") or 0) / 1000.0)
            end = min(nxt, start + 1.5) if nxt > start else start + 0.3
        else:
            end = min(total or start + _LAST_WORD_TAIL, start + _LAST_WORD_TAIL) or (start + _LAST_WORD_TAIL)
        if end <= start:
            end = start + 0.2
        words.append({"word": text, "start": round(start, 3), "end": round(end, 3)})
    return words


def synthesize(
    text: str,
    wav_path: str,
    *,
    voice: str | None = None,
    speed: float = 1.0,
) -> NarrationResult:
    """Synthesize ``text`` to ``wav_path`` and return real word timings."""
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

    words = _timings_to_words(raw, duration)
    if not words:  # even-spacing fallback so captions still render
        toks = [w for w in text.split() if w.strip()]
        if toks and duration > 0:
            step = duration / len(toks)
            words = [
                {"word": w, "start": round(i * step, 3), "end": round((i + 1) * step, 3)}
                for i, w in enumerate(toks)
            ]

    if not duration and words:
        duration = words[-1]["end"]

    return NarrationResult(wav_path=wav_path, duration=duration, voice=voice, words=words)
