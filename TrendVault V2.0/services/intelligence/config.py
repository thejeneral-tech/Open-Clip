"""Central configuration. Everything is overridable via environment variables."""
from __future__ import annotations

import os
from pathlib import Path


def _env(key: str, default: str) -> str:
    return os.environ.get(key, default)


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, default))
    except (TypeError, ValueError):
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, default))
    except (TypeError, ValueError):
        return default


# --- Paths ---------------------------------------------------------------
# Rooted in TrendVault V2.0's data/ tree (core/constants.py) so this section
# follows the studio's layout: data/intelligence/{videos,exports,clips} + its
# own SQLite DB. YIA_DATA_DIR still relocates the whole tree for power users.
from core.constants import INTEL_DIR

DATA_DIR = Path(_env("YIA_DATA_DIR", INTEL_DIR))
DB_PATH = DATA_DIR / "intelligence.db"
VIDEO_DATA_DIR = DATA_DIR / "videos"   # per-video working dirs (frames, audio, downloads)
EXPORT_DIR = DATA_DIR / "exports"
CLIPS_DIR = DATA_DIR / "clips"         # rendered vertical clips, grouped by run id

for _d in (DATA_DIR, VIDEO_DATA_DIR, EXPORT_DIR, CLIPS_DIR):
    _d.mkdir(parents=True, exist_ok=True)


# --- Ollama / local LLMs -------------------------------------------------
# Share TrendVault's configured local-LLM backend so the Settings → AI Model tab
# governs which Ollama server + model this section uses. We talk to Ollama's
# NATIVE API (/api/generate, /api/chat, /api/tags), so strip a trailing /v1 from
# the OpenAI-compatible base in core.config. localhost→127.0.0.1: on Windows
# "localhost" resolves to IPv6 (::1) first and stalls ~2s per call before
# falling back to IPv4 (Ollama listens on IPv4), and that hits every request.
def _derive_ollama_url() -> str:
    from core.config import config as _tv
    base = (_tv.local_llm_url or "").rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")].rstrip("/")
    base = base or "http://127.0.0.1:11434"
    return base.replace("://localhost", "://127.0.0.1")


def _derive_reasoning_model() -> str:
    from core.config import config as _tv
    return (_tv.local_llm_model or "").strip() or "deepseek-r1:8b"


# OLLAMA_URL / YIA_REASONING_MODEL env vars still win for remote/containerized
# Ollama or a pinned model; otherwise both track the studio's Settings.
OLLAMA_URL = _env("OLLAMA_URL", _derive_ollama_url()).rstrip("/")
REASONING_MODEL = _env("YIA_REASONING_MODEL", _derive_reasoning_model())
# Optional explicit vision model. If empty we auto-detect from installed models.
VISION_MODEL = _env("YIA_VISION_MODEL", "").strip()
LLM_TIMEOUT = _env_int("YIA_LLM_TIMEOUT", 600)        # seconds, reasoning models are slow
LLM_NUM_CTX = _env_int("YIA_LLM_NUM_CTX", 8192)        # context window for ollama options

# Smaller text models to fall back to (in priority order) when the reasoning
# model can't be loaded for lack of memory, or isn't installed. Only models
# actually present in Ollama are tried. On a low-RAM box deepseek-r1:8b often
# 500s with "requires more system memory than available"; these keep the app
# working instead of erroring out. Set YIA_FALLBACK_MODELS="" to disable.
FALLBACK_MODELS: tuple[str, ...] = tuple(
    m.strip()
    for m in _env("YIA_FALLBACK_MODELS", "llama3.2:1b,qwen2.5:0.5b").split(",")
    if m.strip()
)
# Spare RAM (MB) we want free on top of a model's on-disk size before attempting
# to load it. If less is available we skip straight to a smaller fallback rather
# than risk a long swap-thrash load that can wedge Ollama. Set to 0 to disable
# the proactive memory check (reactive fallback on load failure still applies).
MODEL_MEMORY_HEADROOM_MB = _env_int("YIA_MODEL_HEADROOM_MB", 512)

# Name fragments that identify a vision-capable Ollama model.
VISION_MODEL_HINTS = (
    "llava", "vision", "-vl", "qwen2.5vl", "qwen2-vl", "minicpm-v",
    "moondream", "bakllava", "llama3.2-vision", "gemma3", "mistral-small3",
)

# --- Whisper (transcription fallback) ------------------------------------
WHISPER_MODEL = _env("YIA_WHISPER_MODEL", "base")      # tiny/base/small/medium/large-v3
WHISPER_DEVICE = _env("YIA_WHISPER_DEVICE", "cpu")     # cpu / cuda
WHISPER_COMPUTE = _env("YIA_WHISPER_COMPUTE", "int8")  # int8 is fast on CPU

# --- Frame extraction ----------------------------------------------------
FRAME_INTERVAL = _env_int("YIA_FRAME_INTERVAL", 8)       # sample 1 frame every N seconds
SCENE_THRESHOLD = _env_float("YIA_SCENE_THRESHOLD", 0.4) # ffmpeg scene-change sensitivity
MAX_FRAMES = _env_int("YIA_MAX_FRAMES", 120)             # hard cap on extracted frames
MAX_VISION_FRAMES = _env_int("YIA_MAX_VISION_FRAMES", 16)  # frames sent to vision model
FRAME_DOWNLOAD_HEIGHT = _env_int("YIA_FRAME_HEIGHT", 480)  # cap download resolution for speed
VISION_FRAME_WIDTH = _env_int("YIA_VISION_FRAME_WIDTH", 768)  # downscale before sending to LLM

# --- Comments ------------------------------------------------------------
MAX_COMMENTS = _env_int("YIA_MAX_COMMENTS", 200)

# --- Topic-to-Clips workflow ---------------------------------------------
# Resolution we download selected source videos at for cutting real clips.
# 720 is a good quality/size/CPU trade-off for vertical short-form output.
RENDER_HEIGHT = _env_int("YIA_RENDER_HEIGHT", 720)
# Vertical render canvas (9:16). Width is derived from height (height*9/16).
RENDER_OUT_HEIGHT = _env_int("YIA_RENDER_OUT_HEIGHT", 1920)
# Defaults for an Auto-Create run (all overridable per-run in the UI).
DEFAULT_VIDEOS_TO_ANALYZE = _env_int("YIA_DEFAULT_VIDEOS", 8)
DEFAULT_CLIPS_TO_CREATE = _env_int("YIA_DEFAULT_CLIPS", 10)
MAX_CLIPS_TO_CREATE = _env_int("YIA_MAX_CLIPS", 10)          # hard cap (spec: up to 10)
MAX_VIDEOS_TO_ANALYZE = _env_int("YIA_MAX_VIDEOS", 15)        # safety cap on a low-RAM box
DEFAULT_MIN_CLIP_LEN = _env_int("YIA_MIN_CLIP_LEN", 18)       # seconds
DEFAULT_MAX_CLIP_LEN = _env_int("YIA_MAX_CLIP_LEN", 60)       # seconds
# Minimum cross-video score for a moment to count as a "strong" clip. We never
# pad weak clips to hit the requested number (spec): if fewer strong moments
# exist than requested, the run reports the real count.
MIN_STRONG_CLIP_SCORE = _env_int("YIA_MIN_STRONG_SCORE", 45)
RENDER_TIMEOUT = _env_int("YIA_RENDER_TIMEOUT", 900)         # per-clip ffmpeg ceiling (s)
# How long cached ytsearch results stay fresh (so retry / find-more don't re-hit
# YouTube). Default 6 hours.
SEARCH_CACHE_TTL = _env_int("YIA_SEARCH_CACHE_TTL", 21600)

# --- Server --------------------------------------------------------------
HOST = _env("YIA_HOST", "127.0.0.1")
PORT = _env_int("YIA_PORT", 8000)


def public_config() -> dict:
    """Safe subset surfaced to the UI."""
    return {
        "reasoning_model": REASONING_MODEL,
        "vision_model": VISION_MODEL or "(auto-detect)",
        "whisper_model": WHISPER_MODEL,
        "ollama_url": OLLAMA_URL,
        "frame_interval": FRAME_INTERVAL,
        "max_comments": MAX_COMMENTS,
        "version": "1.0.0",
    }
