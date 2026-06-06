# app.py — slim orchestrator for TrendVault Studio V2.0 (mirrors TrendVault-Coder/app.py)
import mimetypes
import os


def register_static_mime_types() -> None:
    """Force stable JS module MIME types across platforms (Windows can ship a
    stale .js mapping that breaks ES-module loading)."""
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("application/javascript", ".mjs")


register_static_mime_types()

from dotenv import load_dotenv
# Load .env by ABSOLUTE path (next to this file) so the app works regardless of
# the launcher's cwd. utf-8-sig tolerates a Notepad BOM (a Windows gotcha).
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
            encoding="utf-8-sig")

import glob
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from core import constants
from core.constants import (
    APP_VERSION, BACKGROUNDS_DIR, CAPTIONS_DIR, GENERATED_VOICES, MUSIC_DIR,
    PREVIEWS_DIR, PUBLIC_AUDIO_DIR, STATIC_DIR, TREND_VAULT_OUT,
)

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("trendvault")

# Ensure every asset/data dir exists before StaticFiles mounts (mounting a
# missing directory raises at import time).
constants.ensure_dirs()


# ========= LIFESPAN =========
@asynccontextmanager
async def _lifespan(app: FastAPI):
    # ── startup ──
    constants.ensure_dirs()
    try:
        from core.database import init_db
        init_db()
    except Exception as e:  # noqa: BLE001
        logger.warning("DB init skipped: %s", e)
    # Sweep orphaned job_*.json from a previous crash so they don't confuse the UI.
    for orphan in glob.glob(os.path.join(TREND_VAULT_OUT, "job_*.json")):
        try:
            os.unlink(orphan)
        except Exception:
            pass
    try:
        from lib.ffmpeg_tools import resolve_ffmpeg, resolve_ffprobe
        logger.info("ffmpeg: %s | ffprobe: %s", resolve_ffmpeg(), resolve_ffprobe())
    except Exception as e:  # noqa: BLE001
        logger.warning("ffmpeg resolve failed: %s", e)
    logger.info("TrendVault Studio v%s ready on port %s", APP_VERSION, constants.__dict__.get("PORT", 3001))
    yield
    # ── shutdown ──
    logger.info("TrendVault Studio shutting down")


app = FastAPI(title="TrendVault Studio", version=APP_VERSION, lifespan=_lifespan)

# ========= CORS =========
allowed = os.getenv("ALLOWED_ORIGINS",
                    "http://localhost:3001,http://127.0.0.1:3001").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Accept", "Authorization", "Content-Type", "X-Requested-With"],
)

# ========= ASSET STATIC MOUNTS (mirror the Express static routes) =========
app.mount("/backgrounds", StaticFiles(directory=BACKGROUNDS_DIR), name="backgrounds")
app.mount("/music", StaticFiles(directory=MUSIC_DIR), name="music")
app.mount("/custom-audio", StaticFiles(directory=PUBLIC_AUDIO_DIR), name="custom-audio")
app.mount("/captions", StaticFiles(directory=CAPTIONS_DIR), name="captions")
app.mount("/trend-vault-clips", StaticFiles(directory=TREND_VAULT_OUT), name="tv-clips")
app.mount("/generated-voices", StaticFiles(directory=GENERATED_VOICES), name="gen-voices")
app.mount("/previews", StaticFiles(directory=PREVIEWS_DIR), name="previews")

# ========= ROUTERS =========
from services.media import get_media_service
from services.render import get_render_service
from services.script import get_script_service
from services.tts import get_tts_service
from routes.media_routes import setup_media_routes
from routes.page_routes import setup_page_routes
from routes.render_routes import setup_render_routes
from routes.script_routes import setup_script_routes
from routes.voice_routes import setup_voice_routes

app.include_router(setup_page_routes())
app.include_router(setup_script_routes(get_script_service()))
app.include_router(setup_voice_routes(get_tts_service()))
app.include_router(setup_render_routes(get_render_service()))
app.include_router(setup_media_routes(get_media_service()))


@app.get("/api/health")
async def health():
    return {"status": "healthy", "version": APP_VERSION}


# ========= FRONTEND ROOT ASSETS (registered LAST so /api/* and pages win) =========
# The studio HTML references assets by root path (/nav.js, /tva-theme.css,
# /tva-theme.js, /vault-icon.svg, …). Serve any real file under static/.
@app.get("/{full_path:path}")
async def static_fallback(full_path: str):
    safe = os.path.normpath(full_path).replace("\\", "/")
    if not full_path or safe.startswith("..") or safe.startswith("/") or ":" in safe:
        raise HTTPException(status_code=404, detail="Not found")
    candidate = os.path.join(STATIC_DIR, *safe.split("/"))
    if os.path.isfile(candidate):
        headers = {"Cache-Control": "no-cache"} if candidate.endswith((".js", ".css", ".html")) else {}
        return FileResponse(candidate, headers=headers)
    raise HTTPException(status_code=404, detail="Not found")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=constants.PORT)
