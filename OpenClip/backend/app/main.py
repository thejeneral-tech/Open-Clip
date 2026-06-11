"""FastAPI application entrypoint."""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select

from app import __version__
from app.api.v1.router import api_router
from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.logging import configure_logging, get_logger
from app.core.security import hash_password
from app.models.settings import UserSettings
from app.models.user import User

logger = get_logger(__name__)


async def _seed_superuser() -> None:
    """Create the bootstrap admin on first boot."""
    async with AsyncSessionLocal() as db:
        count = (await db.execute(select(func.count(User.id)))).scalar_one()
        if count > 0:
            return
        logger.info("Seeding bootstrap superuser %s", settings.FIRST_SUPERUSER_EMAIL)
        user = User(
            email=settings.FIRST_SUPERUSER_EMAIL.lower(),
            hashed_password=hash_password(settings.FIRST_SUPERUSER_PASSWORD),
            full_name="Administrator",
            role="admin",
            is_superuser=True,
        )
        db.add(user)
        await db.flush()
        db.add(UserSettings(user_id=user.id))
        await db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    logger.info("Starting %s v%s (%s)", settings.PROJECT_NAME, __version__, settings.ENVIRONMENT)
    if settings.is_sqlite:
        # Ensure data dirs + schema exist before we touch the database.
        from app.db_init import init_db

        await asyncio.to_thread(init_db)
    try:
        await _seed_superuser()
    except Exception as exc:  # pragma: no cover - don't crash if DB not ready yet
        logger.warning("Superuser seeding skipped: %s", exc)
    try:
        from app.services.preset_store import seed_system_presets

        await asyncio.to_thread(seed_system_presets)
    except Exception as exc:  # pragma: no cover
        logger.warning("Preset seeding skipped: %s", exc)

    from app.core.scheduler import start_scheduler, stop_scheduler

    start_scheduler()
    yield
    await stop_scheduler()
    logger.info("Shutting down")


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.PROJECT_NAME,
        version=__version__,
        description="Self-hosted, AI-powered short-form clip generation (Opus Clip alternative).",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.BACKEND_CORS_ORIGINS or ["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(api_router, prefix=settings.API_V1_PREFIX)

    # Serve media from the local storage root (the Next.js dev server proxies
    # /media/* here; with an S3 backend this mount is skipped).
    if settings.STORAGE_BACKEND == "local":
        os.makedirs(settings.STORAGE_ROOT, exist_ok=True)
        app.mount(
            settings.PUBLIC_MEDIA_URL,
            StaticFiles(directory=settings.STORAGE_ROOT),
            name="media",
        )

    @app.get("/health", tags=["meta"])
    async def health() -> dict:
        return {"status": "ok", "version": __version__, "environment": settings.ENVIRONMENT}

    @app.get("/", include_in_schema=False)
    async def root():
        return RedirectResponse(url="/api/docs")

    return app


app = create_app()
