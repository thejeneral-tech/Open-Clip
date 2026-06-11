"""Application configuration.

All settings are read from environment variables (and an optional ``.env`` file)
using :mod:`pydantic-settings`. A single cached :data:`settings` instance is
imported everywhere else in the codebase.

The defaults target a fully **local, Docker-free** stack:

* **SQLite** for metadata (no PostgreSQL server to run), and
* a **filesystem** Celery broker + SQLite result backend (no Redis to run).

Set ``DB_BACKEND=postgres`` and a ``CELERY_BROKER_URL`` to opt back into the
heavier services if you ever want them.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# Repository root: .../backend/app/core/config.py -> parents[3] == repo root.
# Relative paths (DATA_DIR, STORAGE_ROOT, SQLITE_PATH) resolve against this so the
# app behaves the same no matter which directory a process is launched from.
_REPO_ROOT = Path(__file__).resolve().parents[3]


def _resolve(path: str) -> str:
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = _REPO_ROOT / p
    return str(p)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # ---- General ----
    PROJECT_NAME: str = "OpenClip"
    ENVIRONMENT: Literal["development", "production", "test"] = "development"
    DEBUG: bool = True
    API_V1_PREFIX: str = "/api/v1"
    # NoDecode: keep pydantic-settings from JSON-parsing the env var so the
    # validator below can accept a plain comma-separated list (or a JSON array).
    BACKEND_CORS_ORIGINS: Annotated[list[str], NoDecode] = Field(default_factory=list)

    # ---- Security ----
    SECRET_KEY: str = "change-me"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30
    ALGORITHM: str = "HS256"
    FIRST_SUPERUSER_EMAIL: str = "admin@openclip.local"
    FIRST_SUPERUSER_PASSWORD: str = "changeme"

    # ---- Paths ----
    # All generated artifacts (database, media, queue, progress) live under DATA_DIR.
    DATA_DIR: str = "./data"

    # ---- Database ----
    DB_BACKEND: Literal["sqlite", "postgres"] = "sqlite"
    SQLITE_PATH: str = "./data/openclip.db"
    # PostgreSQL — only used when DB_BACKEND=postgres.
    POSTGRES_HOST: str = "localhost"
    POSTGRES_PORT: int = 5432
    POSTGRES_USER: str = "openclip"
    POSTGRES_PASSWORD: str = "openclip"
    POSTGRES_DB: str = "openclip"

    # ---- Background tasks (Celery) ----
    # Redis-free by default: a filesystem broker keeps the queue on disk and the
    # results in a SQLite file, so nothing extra needs installing.
    CELERY_BROKER_URL: str = "filesystem://"
    CELERY_RESULT_BACKEND: str = ""  # empty -> derived SQLite path under DATA_DIR
    WORKER_CONCURRENCY: int = 2

    # ---- Storage ----
    STORAGE_BACKEND: Literal["local", "s3"] = "local"
    STORAGE_ROOT: str = "./data/storage"
    PUBLIC_MEDIA_URL: str = "/media"
    S3_ENDPOINT_URL: str | None = None
    S3_REGION: str = "us-east-1"
    S3_BUCKET: str = "openclip"
    S3_ACCESS_KEY: str | None = None
    S3_SECRET_KEY: str | None = None
    S3_USE_SSL: bool = True

    # ---- Ollama ----
    # Use the IPv4 loopback literal, not "localhost": on Windows, resolving
    # "localhost" tries IPv6 (::1) first and waits ~2s to fall back to IPv4 on
    # every request, taxing *all* AI calls (discovery/scoring/clipping/…). The
    # 127.0.0.1 literal skips that and responds in ~30ms.
    OLLAMA_BASE_URL: str = "http://127.0.0.1:11434"
    OLLAMA_TIMEOUT: int = 600
    OLLAMA_DEFAULT_MODEL: str = "qwen3:32b"
    OLLAMA_RANKING_MODEL: str = "qwen3:32b"
    OLLAMA_VISION_MODEL: str = "gemma3:27b"
    OLLAMA_EMBED_MODEL: str = "nomic-embed-text"
    OLLAMA_KEEP_ALIVE: str = "15m"
    OLLAMA_NUM_CTX: int = 8192
    # Max simultaneous Ollama generations *per worker process*. Keep at 1 for a
    # single GPU; raise for multi-GPU hosts (Tesla P40/P100/V100, RTX). The
    # centralized OllamaService gates every AI request behind this.
    OLLAMA_MAX_CONCURRENCY: int = 1

    # ---- Bot automation ----
    # The API process runs a lightweight asyncio scheduler that dispatches due
    # bot cycles as Celery tasks — no separate `celery beat` service required.
    BOT_SCHEDULER_ENABLED: bool = True
    BOT_SCHEDULER_INTERVAL_SECONDS: int = 60
    # Network identity for public discovery requests (Reddit/RSS) — be a good
    # citizen and identify the deployment.
    DISCOVERY_USER_AGENT: str = "OpenClip-Bot/1.0 (+https://github.com/openclip)"
    # Safety valve: ingestion/processing per bot cycle is capped here regardless
    # of preset settings, so a misconfigured bot can't flood the worker.
    BOT_MAX_VIDEOS_PER_RUN: int = 5
    # Global ceiling (seconds) on the length of videos a bot will discover. Acts
    # as an upper bound on each bot's filter ``max_duration`` — a bot may be
    # stricter but never looser. 0 disables the global cap. Default 1800 = 30 min.
    BOT_MAX_VIDEO_DURATION_SECONDS: int = 1800

    # ---- Publishing: YouTube OAuth ----
    # A Google Cloud OAuth 2.0 *Web application* client with the "YouTube Data
    # API v3" enabled. Connecting a channel runs a real OAuth consent flow and
    # stores the returned refresh token on the connector row; uploads use
    # youtube.videos.insert. Other platforms (TikTok/IG/X/Facebook) are surfaced
    # in the UI as "coming soon" until their integrations land.
    GOOGLE_CLIENT_ID: str | None = None
    GOOGLE_CLIENT_SECRET: str | None = None
    # Must EXACTLY match an "Authorized redirect URI" on the OAuth client. Google
    # redirects the browser here after consent; the backend handles the code.
    GOOGLE_OAUTH_REDIRECT_URI: str = "http://localhost:8000/api/v1/publishing/youtube/callback"
    # Where the backend sends the browser back to once a channel is connected.
    FRONTEND_BASE_URL: str = "http://localhost:3000"
    # Default privacy for bot-published Shorts ("public" | "unlisted" | "private").
    YOUTUBE_DEFAULT_PRIVACY: Literal["public", "unlisted", "private"] = "private"

    # ---- Transcription ----
    WHISPER_ENGINE: Literal["faster-whisper", "whisper"] = "faster-whisper"
    WHISPER_MODEL: str = "large-v3-turbo"
    WHISPER_DEVICE: str = "cpu"
    WHISPER_COMPUTE_TYPE: str = "int8"
    WHISPER_BEAM_SIZE: int = 5
    # CTranslate2 intra-op threads for CPU transcription. 0 = let CT2 decide
    # (~4). On a many-core CPU, set to the number of performance cores for a
    # meaningful speedup. Ignored on GPU.
    WHISPER_CPU_THREADS: int = 0
    ENABLE_DIARIZATION: bool = False
    HUGGINGFACE_TOKEN: str | None = None

    # ---- Voice cloning (Fish Speech S2) ----
    # The s2.cpp HTTP server (`s2 --server`) that clones a voice from a short
    # reference clip + its transcript. Run locally on this loopback URL.
    FISH_TTS_URL: str = "http://127.0.0.1:8080"
    FISH_TEMPERATURE: float = 0.7
    FISH_MAX_TOKENS: int = 2048
    # Folder holding the s2-pro GGUF quants + tokenizer (used to report which
    # quants are downloaded). Empty = unknown; set it to the s2-pro-gguf folder.
    FISH_MODEL_DIR: str = ""

    # ---- Video processing ----
    FFMPEG_BIN: str = "ffmpeg"
    FFPROBE_BIN: str = "ffprobe"
    HWACCEL: Literal["none", "nvenc", "qsv", "amf"] = "none"
    # How many clips to enrich+render concurrently within one worker process.
    # Each clip render is an ffmpeg subprocess, so >1 overlaps the (ffmpeg-bound)
    # render of one clip with the LLM/reframe work of another. Keep modest: a
    # hardware encoder (QSV/NVENC) has limited parallel sessions. 1 = sequential.
    CLIP_CONCURRENCY: int = 1
    DEFAULT_EXPORT_RESOLUTION: str = "1080p"
    DEFAULT_EXPORT_FORMAT: str = "mp4"
    TRACKING_SAMPLE_FPS: int = 5
    ENABLE_YOLO: bool = True
    YOLO_MODEL: str = "yolov8n.pt"
    # Device for YOLO person detection in smart-reframe. Default "cpu": this box's
    # Tesla P100 is compute capability sm_60, which the installed PyTorch build
    # has no kernels for (CUDA "no kernel image is available" → crash). yolov8n on
    # CPU is plenty fast at the ~5fps tracking sample rate. Set "cuda"/"0" only on
    # a GPU whose CC is supported by the installed torch.
    YOLO_DEVICE: str = "cpu"
    # Larger YOLO used when a user enables "high-accuracy subject detection" in
    # Settings (better in dark/wide shots; ~2-3x slower on CPU). Auto-downloads
    # from ultralytics on first use.
    YOLO_MODEL_HQ: str = "yolov8s.pt"

    # ---- Reframe smoothing / render ----
    # Dense sendcmd grid ceiling (Hz). When the crop DOES move (a re-centre
    # glide), it is animated at min(this, source fps) so the glide is per-frame
    # smooth instead of stepping at the analysis rate.
    REFRAME_RENDER_FPS: int = 30
    # Lock-and-hold: the crop is piecewise-STATIC. It locks onto the subject
    # and moves only on (a) a scene cut — instant snap, invisible across a cut —
    # or (b) the subject sustainably leaving the deadband — one smoothstep
    # glide, then locked again. Jitter and dropouts never move the crop.
    REFRAME_SCENE_CORREL: float = 0.5       # HSV-hist correlation between samples below this = scene cut
    REFRAME_DEADBAND: float = 0.12          # norm distance the subject may roam without the crop moving
    REFRAME_RETARGET_SECONDS: float = 1.0   # deadband breach must persist this long before re-centring
    REFRAME_EASE_SECONDS: float = 1.2       # duration of the smoothstep re-centre glide
    REFRAME_LOOKAHEAD_SECONDS: float = 1.0  # anchor = median of this upcoming detection window
    # Composition: vertical position of the subject centre within the crop
    # (0.5 = dead centre). 0.42 gives rule-of-thirds-ish headroom whenever the
    # crop can move vertically (no-op for 16:9 → 9:16, where the crop is full
    # height).
    REFRAME_SUBJECT_Y: float = 0.42
    # Subject lock / anti-flicker.
    REFRAME_SWITCH_DIST: float = 0.25     # norm distance beyond which a detection is a NEW subject
    REFRAME_SWITCH_HOLD: int = 3          # consecutive samples a far subject must persist before the lock moves
    REFRAME_PERSON_HEAD_FRAC: float = 0.15  # head estimate = person box_top + this*box_height

    # ---- Limits ----
    MAX_UPLOAD_SIZE_MB: int = 4096
    MAX_CLIPS_PER_VIDEO: int = 50
    MIN_CLIP_SECONDS: int = 8
    MAX_CLIP_SECONDS: int = 90

    # -------------------------------------------------------------- validators
    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    @classmethod
    def _split_cors(cls, v: Any) -> list[str]:
        if v is None or v == "":
            return []
        if isinstance(v, str):
            s = v.strip()
            if s.startswith("["):  # tolerate a JSON array too
                try:
                    return list(json.loads(s))
                except json.JSONDecodeError:
                    return []
            return [i.strip() for i in s.split(",") if i.strip()]
        if isinstance(v, list):
            return v
        return []

    @model_validator(mode="after")
    def _resolve_paths(self) -> Settings:
        # Make all on-disk locations absolute & launch-directory independent.
        self.DATA_DIR = _resolve(self.DATA_DIR)
        self.STORAGE_ROOT = _resolve(self.STORAGE_ROOT)
        self.SQLITE_PATH = _resolve(self.SQLITE_PATH)
        return self

    # -------------------------------------------------------------- derived
    @property
    def is_sqlite(self) -> bool:
        return self.DB_BACKEND == "sqlite"

    @property
    def sqlalchemy_database_uri(self) -> str:
        """Async connection string used by the FastAPI app."""
        if self.is_sqlite:
            return f"sqlite+aiosqlite:///{Path(self.SQLITE_PATH).as_posix()}"
        return (
            f"postgresql+asyncpg://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    @property
    def sync_database_uri(self) -> str:
        """Sync connection string used by Celery workers + Alembic."""
        if self.is_sqlite:
            return f"sqlite:///{Path(self.SQLITE_PATH).as_posix()}"
        return (
            f"postgresql+psycopg://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    @property
    def celery_result_backend(self) -> str:
        if self.CELERY_RESULT_BACKEND:
            return self.CELERY_RESULT_BACKEND
        return f"db+sqlite:///{Path(self.DATA_DIR, 'celery_results.db').as_posix()}"

    @property
    def celery_broker_dir(self) -> str:
        return str(Path(self.DATA_DIR, "celery"))

    @property
    def progress_dir(self) -> str:
        return str(Path(self.DATA_DIR, "progress"))

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == "production"

    @property
    def youtube_oauth_configured(self) -> bool:
        """True once a Google OAuth client is present (channels can be connected)."""
        return bool(self.GOOGLE_CLIENT_ID and self.GOOGLE_CLIENT_SECRET)


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
