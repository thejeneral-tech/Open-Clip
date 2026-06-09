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
    OLLAMA_BASE_URL: str = "http://localhost:11434"
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

    # ---- Transcription ----
    WHISPER_ENGINE: Literal["faster-whisper", "whisper"] = "faster-whisper"
    WHISPER_MODEL: str = "large-v3"
    WHISPER_DEVICE: str = "cpu"
    WHISPER_COMPUTE_TYPE: str = "int8"
    WHISPER_BEAM_SIZE: int = 5
    # CTranslate2 intra-op threads for CPU transcription. 0 = let CT2 decide
    # (~4). On a many-core CPU, set to the number of performance cores for a
    # meaningful speedup. Ignored on GPU.
    WHISPER_CPU_THREADS: int = 0
    ENABLE_DIARIZATION: bool = False
    HUGGINGFACE_TOKEN: str | None = None

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

    # ---- Reframe smoothing / render ----
    # Dense sendcmd grid ceiling (Hz). The crop is animated at min(this, source
    # fps) so it pans continuously instead of stepping at the analysis rate.
    REFRAME_RENDER_FPS: int = 30
    # One-Euro filter: low cutoff = steadier when the subject is still; the
    # cutoff opens with (filtered) speed so fast pans stay responsive.
    REFRAME_MIN_CUTOFF: float = 1.0   # Hz; lower = smoother/steadier when still
    REFRAME_BETA: float = 0.02        # speed coupling (tuned for normalized 0..1 coords)
    REFRAME_D_CUTOFF: float = 1.0     # derivative low-pass cutoff (Hz)
    # Subject lock / anti-flicker.
    REFRAME_SWITCH_DIST: float = 0.25     # norm distance beyond which a detection is a NEW subject
    REFRAME_SWITCH_HOLD: int = 3          # consecutive samples a far subject must persist before the lock moves
    REFRAME_PERSON_HEAD_FRAC: float = 0.15  # head estimate = person box_top + this*box_height
    # Detection dropout handling.
    REFRAME_MAX_HOLD_SECONDS: float = 1.5      # after this much continuous miss, ease held center toward frame center
    REFRAME_REACQUIRE_GAP_SECONDS: float = 0.4  # gaps longer than this reset the filter (clean re-acquire, no pre-echo)

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


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
