"""Locate an ffmpeg binary: prefer a system install, fall back to the
pip-bundled binary from imageio-ffmpeg so the user never has to install it."""
from __future__ import annotations

import functools
import os
import shutil
from pathlib import Path


@functools.lru_cache(maxsize=1)
def ffmpeg_path() -> str | None:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


@functools.lru_cache(maxsize=1)
def ffprobe_path() -> str | None:
    return shutil.which("ffprobe")  # may be None; we avoid hard-depending on it


@functools.lru_cache(maxsize=1)
def ffmpeg_location_for_ytdlp() -> str | None:
    """Directory containing ffmpeg, for yt-dlp's ffmpeg_location option."""
    p = ffmpeg_path()
    return str(Path(p).parent) if p else None


def have_ffmpeg() -> bool:
    return ffmpeg_path() is not None


@functools.lru_cache(maxsize=1)
def ensure_ffmpeg_on_path() -> str | None:
    """Make a binary literally named `ffmpeg` available on PATH. Some tools
    (e.g. openai-whisper) invoke `ffmpeg` by name; our bundled binary has an
    odd name, so we copy it to data/bin/ffmpeg(.exe) and prepend that to PATH.
    Returns the directory added, or None if ffmpeg is unavailable."""
    if shutil.which("ffmpeg"):
        return str(Path(shutil.which("ffmpeg")).parent)
    exe = ffmpeg_path()
    if not exe:
        return None
    from .config import DATA_DIR
    bindir = DATA_DIR / "bin"
    bindir.mkdir(parents=True, exist_ok=True)
    name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    target = bindir / name
    try:
        if not target.exists() or target.stat().st_size == 0:
            shutil.copy2(exe, target)
    except Exception:
        return None
    os.environ["PATH"] = str(bindir) + os.pathsep + os.environ.get("PATH", "")
    return str(bindir)
