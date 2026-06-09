"""Application-wide constants and path configuration for TrendVault Studio V2.0.

Mirrors TrendVault-Coder/core/constants.py: plain module-level path constants
derived from BASE_DIR (the repo folder containing app.py). Everything the
backend reads or writes resolves from here, so the layout is portable.
"""
import os

APP_VERSION = "2.0.0"
# Build identifier — bump when shipping a code change. The frontend carries a
# matching FRONTEND_BUILD constant and warns on screen if the two disagree, so a
# stale browser cache or a server running an old checkout is immediately visible.
BUILD_ID = "TV-20260608-AI2"
PORT = int(os.getenv("PORT", "3001"))

# ── Base paths ──
# constants.py lives in core/, so BASE_DIR is its parent's parent.
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = BASE_DIR  # alias used by render orchestration (cwd for the Node subprocess)

STATIC_DIR  = os.path.join(BASE_DIR, "static")
DATA_DIR    = os.path.join(BASE_DIR, "data")
PUBLIC_DIR  = os.path.join(BASE_DIR, "public")
SCRIPTS_DIR = os.path.join(BASE_DIR, "scripts")

# ── Asset roots (served as static mounts, mirroring the Express app) ──
BACKGROUNDS_DIR  = os.path.join(BASE_DIR, "backgrounds")
MUSIC_DIR        = os.path.join(BASE_DIR, "music")
CUSTOM_AUDIO_DIR = os.path.join(BASE_DIR, "custom-audio")
TREND_VAULT_OUT  = os.path.join(BASE_DIR, "trend-vault-output")

# ── public/ subdirs (Remotion staticFile root + browser-served audio/captions) ──
PUBLIC_AUDIO_DIR = os.path.join(PUBLIC_DIR, "custom-audio")
CAPTIONS_DIR     = os.path.join(PUBLIC_DIR, "captions")
PREVIEWS_DIR     = os.path.join(PUBLIC_DIR, "previews")
PUBLIC_BG_DIR    = os.path.join(PUBLIC_DIR, "backgrounds")
PUBLIC_MUSIC_DIR = os.path.join(PUBLIC_DIR, "music")

# ── data/ subdirs ──
DRAFTS_DIR       = os.path.join(DATA_DIR, "drafts")
GENERATED_VOICES = os.path.join(DATA_DIR, "generated-voices")

# ── Intelligence Agent (the "Clip Tool") — ported YouTube Video Intelligence
#    Agent. Self-contained data root under data/, mirroring its standalone
#    layout: per-video working dirs (frames/audio/downloads), exports, rendered
#    vertical clips grouped by run id, and its own SQLite DB.
INTEL_DIR        = os.path.join(DATA_DIR, "intelligence")
INTEL_VIDEO_DIR  = os.path.join(INTEL_DIR, "videos")
INTEL_EXPORT_DIR = os.path.join(INTEL_DIR, "exports")
INTEL_CLIPS_DIR  = os.path.join(INTEL_DIR, "clips")
INTEL_DB_PATH    = os.path.join(INTEL_DIR, "intelligence.db")

# ── Data files (JSON state) ──
VOICE_PRESETS_FILE     = os.path.join(DATA_DIR, "voice-presets.json")
CUSTOM_PRESETS_FILE    = os.path.join(DATA_DIR, "custom-presets.json")
FISH_PRESETS_FILE      = os.path.join(DATA_DIR, "fish-voice-presets.json")
HIDDEN_VOICES_FILE     = os.path.join(DATA_DIR, "hidden-voices.json")
PROMPTS_FILE           = os.path.join(DATA_DIR, "prompts.json")
RECENT_HOOKS_FILE      = os.path.join(DATA_DIR, "recent-hooks.json")
# Built-in Kokoro voice library used by the TTS engine for synthesis params.
TTS_VOICE_PRESETS_FILE = os.path.join(SCRIPTS_DIR, "tts", "voicePresets.json")

# ── Database ──
DB_PATH = os.path.join(DATA_DIR, "app.db")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///" + DB_PATH.replace("\\", "/"))

# ── Models / pipeline ──
# Script generation runs on a local LLM; see LOCAL_LLM_URL / LOCAL_LLM_MODEL in
# core/config.py (override via .env).
SCRIPT_TARGET_SECONDS = 90

# Node render entrypoint (spawned via `npx tsx <RENDER_SCRIPT>` with cwd=ROOT)
RENDER_SCRIPT = os.path.join("scripts", "trend-vault-render.ts")

# ── TTS ──
TTS_CHUNK_MAX_CHARS    = 160
MIN_FINAL_DURATION_SEC = 1.0
MIN_CHUNK_BYTES        = 2000
RENDER_AUDIO_FLOOR_SEC = 0.4   # silent-video guard: abort render if TTS shorter

# ── SSE ──
SSE_LOG_CAP = 500

# Every directory that must exist before mounting StaticFiles / running.
ALL_DIRS = [
    STATIC_DIR, DATA_DIR, PUBLIC_DIR, SCRIPTS_DIR,
    BACKGROUNDS_DIR, MUSIC_DIR, CUSTOM_AUDIO_DIR, TREND_VAULT_OUT,
    PUBLIC_AUDIO_DIR, CAPTIONS_DIR, PREVIEWS_DIR, PUBLIC_BG_DIR, PUBLIC_MUSIC_DIR,
    DRAFTS_DIR, GENERATED_VOICES,
    INTEL_DIR, INTEL_VIDEO_DIR, INTEL_EXPORT_DIR, INTEL_CLIPS_DIR,
]


def ensure_dirs() -> None:
    for d in ALL_DIRS:
        os.makedirs(d, exist_ok=True)
