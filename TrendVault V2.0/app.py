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

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from core import constants
from core.constants import (
    APP_VERSION, BACKGROUNDS_DIR, BUILD_ID, CAPTIONS_DIR, GENERATED_VOICES,
    INTEL_CLIPS_DIR, INTEL_VIDEO_DIR, MUSIC_DIR,
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
    # Apply persisted local-LLM settings (model/backend) over the .env defaults.
    try:
        from services.llm import model_admin
        model_admin.load_overrides()
    except Exception as e:  # noqa: BLE001
        logger.warning("LLM settings load skipped: %s", e)
    try:
        from core.database import init_db
        init_db()
    except Exception as e:  # noqa: BLE001
        logger.warning("DB init skipped: %s", e)
    # Intelligence Agent (the "Clip Tool") — own SQLite DB; reap any search left
    # mid-flight by a previous crash so the UI can offer Retry instead of hanging.
    try:
        from services.intelligence import database as intel_db
        intel_db.init_db()
        reaped = intel_db.reap_orphan_search_jobs()
        if reaped:
            logger.info("Intelligence: recovered %d interrupted search job(s).", reaped)
    except Exception as e:  # noqa: BLE001
        logger.warning("Intelligence DB init skipped: %s", e)
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
    # ── BOOT banner — proves which project/build this process is actually running.
    import sys as _sys
    from core.config import config as _cfg
    logger.info("[BOOT] Project root:   %s", constants.BASE_DIR)
    logger.info("[BOOT] Backend file:   %s", os.path.abspath(__file__))
    logger.info("[BOOT] Static dir:     %s", STATIC_DIR)
    logger.info("[BOOT] Trend Vault:    %s", os.path.join(STATIC_DIR, "trend-vault.html"))
    logger.info("[BOOT] Python exe:     %s", _sys.executable)
    logger.info("[BOOT] Server URL:     http://127.0.0.1:%s", constants.PORT)
    logger.info("[BOOT] Process ID:     %s", os.getpid())
    logger.info("[BOOT] LLM URL:        %s", _cfg.local_llm_url)
    logger.info("[BOOT] Build/Version:  %s  (v%s)", BUILD_ID, APP_VERSION)
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

# ========= AUTH (mirrors TrendVault-Coder/app.py) =========
from core.auth import AuthManager
from routes.auth_routes import setup_auth_routes, SESSION_COOKIE

auth_manager = AuthManager()
app.state.auth_manager = auth_manager
AUTH_ENABLED = os.getenv("AUTH_ENABLED", "true").lower() != "false"
LOCALHOST_BYPASS = os.getenv("LOCALHOST_BYPASS", "false").lower() == "true"
if LOCALHOST_BYPASS:
    logger.warning("LOCALHOST_BYPASS enabled — loopback requests skip login. "
                   "Do not expose this instance to a network.")

if AUTH_ENABLED:
    # Exact paths that must stay reachable without a session: the login page and
    # the auth endpoints it calls, plus health/version.
    AUTH_EXEMPT_EXACT = {
        "/api/auth/setup", "/api/auth/signup", "/api/auth/login",
        "/api/auth/logout", "/api/auth/status",
        "/api/health", "/api/version", "/login",
    }
    # The studio's UI assets are served from ROOT paths (/tva-theme.css,
    # /tva-theme.js, /nav.js, /vault-icon.svg, favicon…) by the catch-all route,
    # so the login page can't render if they 302 to /login. Exempt those asset
    # types by extension. Media mounts (/backgrounds, /music, generated voices,
    # clips…) and the HTML pages stay gated.
    _STATIC_EXT = (".css", ".js", ".mjs", ".svg", ".woff", ".woff2",
                   ".ttf", ".map", ".ico", ".webmanifest")

    def _is_auth_exempt(path: str) -> bool:
        # /api/debug/* are localhost-only diagnostics (no secrets/transcripts) and
        # must work before login so a broken deploy can be diagnosed.
        return (path in AUTH_EXEMPT_EXACT or path.endswith(_STATIC_EXT)
                or path.startswith("/api/debug/"))

    def _is_trusted_loopback(request: Request) -> bool:
        """True only for a DIRECT loopback connection with no proxy/tunnel
        forwarding headers — a reverse proxy connects from loopback too, so a
        bare client.host check would let a remote visitor inherit local trust."""
        host = request.client.host if request.client else None
        if host not in ("127.0.0.1", "::1"):
            return False
        for h in ("x-forwarded-for", "x-real-ip", "forwarded",
                  "cf-connecting-ip", "x-forwarded-host"):
            if request.headers.get(h):
                return False
        return True

    class AuthMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next):
            path = request.url.path
            if _is_auth_exempt(path):
                return await call_next(request)
            if LOCALHOST_BYPASS and _is_trusted_loopback(request):
                return await call_next(request)
            if not auth_manager.is_configured:
                # No users yet — send browsers to /login for first-run setup.
                if not path.startswith("/api/"):
                    return RedirectResponse(url="/login", status_code=302)
                return JSONResponse(status_code=401, content={"error": "Setup required"})
            # Cookie-based session auth
            token = request.cookies.get(SESSION_COOKIE)
            if not auth_manager.validate_token(token):
                if path.startswith("/api/"):
                    return JSONResponse(status_code=401, content={"error": "Not authenticated"})
                return RedirectResponse(url="/login", status_code=302)
            request.state.current_user = auth_manager.get_username_for_token(token)
            return await call_next(request)

    app.add_middleware(AuthMiddleware)
    logger.info("Auth middleware enabled (AUTH_ENABLED=true)")
else:
    logger.info("Auth middleware disabled (set AUTH_ENABLED=true to enable login)")


# ========= ASSET STATIC MOUNTS (mirror the Express static routes) =========
app.mount("/backgrounds", StaticFiles(directory=BACKGROUNDS_DIR), name="backgrounds")
app.mount("/music", StaticFiles(directory=MUSIC_DIR), name="music")
app.mount("/custom-audio", StaticFiles(directory=PUBLIC_AUDIO_DIR), name="custom-audio")
app.mount("/captions", StaticFiles(directory=CAPTIONS_DIR), name="captions")
app.mount("/trend-vault-clips", StaticFiles(directory=TREND_VAULT_OUT), name="tv-clips")
app.mount("/generated-voices", StaticFiles(directory=GENERATED_VOICES), name="gen-voices")
app.mount("/previews", StaticFiles(directory=PREVIEWS_DIR), name="previews")
# Intelligence Agent media: extracted frames (per video) + rendered clips (per run).
app.mount("/intel-media", StaticFiles(directory=INTEL_VIDEO_DIR), name="intel-media")
app.mount("/intel-clips", StaticFiles(directory=INTEL_CLIPS_DIR), name="intel-clips")

# ========= ROUTERS =========
from services.media import get_media_service
from services.render import get_render_service
from services.script import get_script_service
from services.tts import get_tts_service
from routes.ai_routes import setup_ai_routes
from routes.debug_routes import setup_debug_routes
from routes.draft_routes import setup_draft_routes
from routes.intelligence_routes import setup_intelligence_routes
from routes.llm_routes import setup_llm_routes
from routes.media_routes import setup_media_routes
from routes.page_routes import setup_page_routes
from routes.render_routes import setup_render_routes
from routes.script_routes import setup_script_routes
from routes.voice_routes import setup_voice_routes

app.include_router(setup_page_routes())
app.include_router(setup_ai_routes())
app.include_router(setup_debug_routes())
app.include_router(setup_draft_routes())
app.include_router(setup_script_routes(get_script_service()))
app.include_router(setup_voice_routes(get_tts_service()))
app.include_router(setup_render_routes(get_render_service()))
app.include_router(setup_media_routes(get_media_service()))
app.include_router(setup_llm_routes())
app.include_router(setup_intelligence_routes())
app.include_router(setup_auth_routes(auth_manager))


@app.get("/api/health")
async def health():
    return {"status": "healthy", "version": APP_VERSION, "build": BUILD_ID}


@app.get("/api/version")
async def version():
    return {"version": APP_VERSION, "build": BUILD_ID}


@app.get("/login")
async def serve_login():
    login_path = os.path.join(STATIC_DIR, "login.html")
    if not os.path.isfile(login_path):
        raise HTTPException(status_code=404, detail="login.html not found")
    return FileResponse(login_path, headers={"Cache-Control": "no-cache"})


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
