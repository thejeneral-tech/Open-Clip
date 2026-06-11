"""Aggregate v1 API router."""
from fastapi import APIRouter

from app.api.v1.endpoints import (
    auth,
    automation,
    bots,
    clips,
    discovery,
    exports,
    models,
    presets,
    projects,
    publishing,
    settings,
    storyvault,
    users,
    videos,
    ws,
)

api_router = APIRouter()
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(projects.router, prefix="/projects", tags=["projects"])
api_router.include_router(videos.router, tags=["videos"])
api_router.include_router(clips.router, tags=["clips"])
api_router.include_router(exports.router, tags=["exports"])
api_router.include_router(settings.router, prefix="/settings", tags=["settings"])
api_router.include_router(models.router, prefix="/models", tags=["models"])
# --- Multi-bot content automation ---
api_router.include_router(bots.router, prefix="/bots", tags=["bots"])
api_router.include_router(presets.router, prefix="/presets", tags=["presets"])
api_router.include_router(discovery.router, prefix="/discovery", tags=["discovery"])
api_router.include_router(publishing.router, prefix="/publishing", tags=["publishing"])
api_router.include_router(automation.router, prefix="/automation", tags=["automation"])
# --- Story Vault (story-to-vertical-video factory) ---
api_router.include_router(storyvault.router, prefix="/storyvault", tags=["storyvault"])
api_router.include_router(ws.router, tags=["ws"])
