"""Media routes — backgrounds, music, custom audio, prompts (Phase 1: listing only)."""
from __future__ import annotations

from fastapi import APIRouter

from services.media.media_service import MediaService


def setup_media_routes(media_service: MediaService) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["media"])

    @router.get("/backgrounds")
    async def backgrounds():
        return media_service.list_backgrounds()

    @router.get("/music")
    async def music():
        return media_service.list_music()

    @router.get("/audio")
    async def audio():
        return media_service.list_audio()

    @router.get("/prompts")
    async def prompts():
        return media_service.get_prompts()

    return router
