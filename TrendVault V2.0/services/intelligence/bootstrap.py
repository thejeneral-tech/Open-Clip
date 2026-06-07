"""Shared first-run bootstrap helpers (standard library only).

Used by install.py and starter.py so dependency setup logic lives in one place.
Notably this pins a KNOWN-GOOD PyTorch range for the CPU build: the newest
cp313 wheels have shipped broken on Windows (torch 2.12.0's c10.dll fails to
initialize; ctranslate2 4.7.2 segfaults), so we deliberately install a mature,
working version instead of "latest".
"""
from __future__ import annotations

import importlib.metadata as _meta
import importlib.util
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUIREMENTS = ROOT / "requirements.txt"

# Core runtime import names that must be present.
CORE_IMPORTS = ["fastapi", "uvicorn", "httpx", "yt_dlp",
                "youtube_transcript_api", "imageio_ffmpeg", "PIL"]

TORCH_INDEX = "https://download.pytorch.org/whl/cpu"
TORCH_SPEC = "torch>=2.6,<2.9"   # avoid broken latest cp313 wheels
TORCH_GOOD_MIN = (2, 6)
TORCH_GOOD_MAX = (2, 9)          # exclusive


def _pip(args: list[str], log) -> int:
    log("pip " + " ".join(args))
    return subprocess.call([sys.executable, "-m", "pip", *args])


def missing_core() -> list[str]:
    return [m for m in CORE_IMPORTS if importlib.util.find_spec(m) is None]


def ensure_core_deps(log) -> bool:
    miss = missing_core()
    if not miss:
        return True
    log(f"Installing core dependencies ({', '.join(miss)})...")
    if _pip(["install", "-r", str(REQUIREMENTS)], log) != 0:
        return False
    return not missing_core()


def torch_version() -> str | None:
    try:
        return _meta.version("torch")
    except Exception:
        return None


def _ver_tuple(v: str) -> tuple[int, int] | None:
    try:
        mj, mn = (int(x) for x in v.split("+")[0].split(".")[:2])
        return (mj, mn)
    except Exception:
        return None


def torch_is_good() -> bool:
    v = torch_version()
    t = _ver_tuple(v) if v else None
    return bool(t and TORCH_GOOD_MIN <= t < TORCH_GOOD_MAX)


def whisper_stack_ok() -> bool:
    """openai-whisper present AND a known-good torch version installed."""
    if importlib.util.find_spec("whisper") is None:
        return False
    return torch_is_good()


def ensure_whisper_stack(log) -> bool:
    """Install the CPU build of a known-good PyTorch + openai-whisper if needed.
    Reinstalls torch if a broken/too-new version is detected."""
    if whisper_stack_ok():
        return True
    v = torch_version()
    if v and not torch_is_good():
        log(f"Replacing PyTorch {v} with a known-good CPU build ({TORCH_SPEC})...")
    else:
        log(f"Installing CPU PyTorch ({TORCH_SPEC}) + openai-whisper...")
    _pip(["install", "--upgrade", TORCH_SPEC, "--index-url", TORCH_INDEX], log)
    _pip(["install", "openai-whisper"], log)
    return whisper_stack_ok()
