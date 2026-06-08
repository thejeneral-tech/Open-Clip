"""ffmpeg / ffprobe via subprocess — Python side of the audio pipeline.

The Node app used fluent-ffmpeg + @ffmpeg-installer. Here we resolve a real
ffmpeg/ffprobe binary (imageio-ffmpeg bundles ffmpeg; ffprobe comes from the
system, the Remotion compositor, or @ffmpeg-installer in node_modules) and shell
out. Mirrors scripts/tts/audioPostProcess.ts: 44.1 kHz mono pipeline, silence
pads, concat, duration probe.

These are blocking calls — invoke from a worker thread (asyncio.to_thread) so the
event loop (and SSE) keeps flowing.
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import tempfile
from typing import List, Optional

from core.constants import ROOT

CONCAT_SAMPLE_RATE = 44100

_FFMPEG: Optional[str] = None
_FFPROBE: Optional[str] = None

# Hide the console window for child processes on Windows.
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _node_modules_bin(name: str) -> Optional[str]:
    exe = name + (".exe" if os.name == "nt" else "")
    for sub in ("@ffmpeg-installer", "@remotion"):
        base = os.path.join(ROOT, "node_modules", sub)
        if os.path.isdir(base):
            hits = glob.glob(os.path.join(base, "**", exe), recursive=True)
            if hits:
                return hits[0]
    return None


def resolve_ffmpeg() -> str:
    global _FFMPEG
    if _FFMPEG:
        return _FFMPEG
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            _FFMPEG = exe
            return exe
    except Exception:
        pass
    w = shutil.which("ffmpeg")
    if w:
        _FFMPEG = w
        return w
    nm = _node_modules_bin("ffmpeg")
    _FFMPEG = nm or "ffmpeg"
    return _FFMPEG


def resolve_ffprobe() -> Optional[str]:
    global _FFPROBE
    if _FFPROBE:
        return _FFPROBE
    w = shutil.which("ffprobe")
    if w:
        _FFPROBE = w
        return w
    nm = _node_modules_bin("ffprobe")
    if nm:
        _FFPROBE = nm
        return nm
    # Try alongside the resolved ffmpeg.
    ff = resolve_ffmpeg()
    cand = os.path.join(os.path.dirname(ff), "ffprobe" + (".exe" if os.name == "nt" else ""))
    if os.path.isfile(cand):
        _FFPROBE = cand
        return cand
    return None


def _run(args: List[str]) -> None:
    subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                   creationflags=_NO_WINDOW)


def probe_duration_sec(path: str) -> float:
    """Seconds of audio/video at `path`. ffprobe first, ffmpeg-stderr fallback."""
    fp = resolve_ffprobe()
    if fp:
        try:
            out = subprocess.run(
                [fp, "-v", "error", "-print_format", "json", "-show_format", path],
                check=True, capture_output=True, text=True, creationflags=_NO_WINDOW,
            ).stdout
            dur = float((json.loads(out).get("format") or {}).get("duration") or 0)
            if dur > 0:
                return dur
        except Exception:
            pass
    # Fallback: parse `ffmpeg -i` stderr for `Duration: HH:MM:SS.ss`
    try:
        ff = resolve_ffmpeg()
        r = subprocess.run([ff, "-i", path], capture_output=True, text=True,
                           creationflags=_NO_WINDOW)
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", r.stderr or "")
        if m:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    except Exception:
        pass
    return 0.0


def probe_scene_changes(path: str, *, threshold: float = 0.4,
                        max_seconds: float = 60.0) -> int:
    """Count hard cuts (scene changes above `threshold`) in the first `max_seconds`.

    Decodes the clip through ffmpeg's `select='gt(scene,…)',showinfo` filter and
    counts the selected frames (one per detected cut). Best-effort and bounded to
    `max_seconds` so a long reference doesn't stall the request. Returns -1 if
    detection could not run (no ffmpeg, decode error) so callers can fall back."""
    ff = resolve_ffmpeg()
    null_sink = "NUL" if os.name == "nt" else "/dev/null"
    try:
        args = [ff, "-hide_banner"]
        if max_seconds and max_seconds > 0:
            args += ["-t", str(max_seconds)]   # input option: limit data read
        args += ["-i", path,
                 "-filter:v", f"select='gt(scene,{threshold})',showinfo",
                 "-an", "-f", "null", null_sink]
        r = subprocess.run(args, capture_output=True, text=True,
                           creationflags=_NO_WINDOW)
        # showinfo logs one `pts_time:` line per frame that passed the select.
        return len(re.findall(r"pts_time:", r.stderr or ""))
    except Exception:
        return -1


def has_audio_stream(path: str) -> bool:
    """True if `path` has at least one audio stream (silent-render guard)."""
    fp = resolve_ffprobe()
    if not fp:
        return True  # can't check → don't block
    try:
        out = subprocess.run(
            [fp, "-v", "error", "-select_streams", "a", "-show_entries",
             "stream=codec_type", "-of", "json", path],
            check=True, capture_output=True, text=True, creationflags=_NO_WINDOW,
        ).stdout
        streams = json.loads(out).get("streams") or []
        return any(s.get("codec_type") == "audio" for s in streams)
    except Exception:
        return True


def generate_silence(duration_sec: float, out_path: str, sr: int = CONCAT_SAMPLE_RATE) -> None:
    if duration_sec <= 0:
        raise ValueError("generate_silence: duration must be > 0")
    ff = resolve_ffmpeg()
    _run([ff, "-y", "-f", "lavfi", "-i",
          f"anullsrc=channel_layout=mono:sample_rate={sr}",
          "-t", f"{duration_sec}", "-c:a", "pcm_s16le", "-ac", "1", "-ar", str(sr), out_path])


def concat_wavs(paths: List[str], out_path: str, sr: int = CONCAT_SAMPLE_RATE) -> None:
    """Concatenate audio files into one wav. Each input is resampled to a common
    44.1 kHz mono so the concat filter never trips on mismatched rates (Kokoro may
    emit 24 kHz; silence pads are 44.1 kHz)."""
    if not paths:
        raise ValueError("concat_wavs: no inputs")
    if len(paths) == 1:
        shutil.copyfile(paths[0], out_path)
        return
    ff = resolve_ffmpeg()
    args = [ff, "-y"]
    for p in paths:
        args += ["-i", p]
    n = len(paths)
    pre = "".join(f"[{i}:a]aresample={sr},aformat=channel_layouts=mono[a{i}];" for i in range(n))
    chain = pre + "".join(f"[a{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[out]"
    args += ["-filter_complex", chain, "-map", "[out]",
             "-c:a", "pcm_s16le", "-ac", "1", "-ar", str(sr), out_path]
    _run(args)


def apply_filter(in_path: str, out_path: str, af_chain: str) -> None:
    """Run an `-af` chain; encode pcm_s16le for .wav, libmp3lame 192k otherwise."""
    ff = resolve_ffmpeg()
    args = [ff, "-y", "-i", in_path, "-af", af_chain, "-ac", "1", "-ar", "44100"]
    if out_path.lower().endswith(".wav"):
        args += ["-c:a", "pcm_s16le"]
    else:
        args += ["-c:a", "libmp3lame", "-b:a", "192k"]
    args += [out_path]
    _run(args)


def tmp_audio_file(ext: str = ".wav") -> str:
    if not ext.startswith("."):
        ext = "." + ext
    fd, p = tempfile.mkstemp(prefix="trend-vault-tts-", suffix=ext)
    os.close(fd)
    return p
