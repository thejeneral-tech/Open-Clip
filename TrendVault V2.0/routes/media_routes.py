"""Media routes — backgrounds, music, custom audio, prompts, reference analysis."""
from __future__ import annotations

import asyncio
import os
import tempfile

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import JSONResponse

from lib.reference_fingerprint import analyze_reference
from services.media.media_service import MediaService

_MAX_UPLOAD_BYTES = 500 * 1024 * 1024  # 500 MB cap for a reference clip


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

    @router.post("/trend-vault/analyze-reference")
    async def analyze_reference_route(video: UploadFile = File(...)):
        """Deterministic (ffprobe/ffmpeg) style-fingerprint of an uploaded clip.

        Streams the upload to a temp file, probes duration + cut frequency to
        estimate pacing, maps that to suggested render settings, and always
        cleans up the temp file. No LLM involved."""
        suffix = os.path.splitext(video.filename or "")[1] or ".mp4"
        fd, tmp = tempfile.mkstemp(prefix="trend-vault-ref-", suffix=suffix)
        try:
            written = 0
            with os.fdopen(fd, "wb") as out:
                while True:
                    chunk = await video.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > _MAX_UPLOAD_BYTES:
                        return JSONResponse(
                            {"ok": False, "error": "Reference file too large (max 500 MB)."},
                            status_code=413,
                        )
                    out.write(chunk)
            if written == 0:
                return JSONResponse({"ok": False, "error": "No video uploaded."},
                                    status_code=400)
            fingerprint = await asyncio.to_thread(analyze_reference, tmp)
            return {"ok": True, "fingerprint": fingerprint}
        except Exception as e:  # noqa: BLE001
            return JSONResponse({"ok": False, "error": f"Analysis failed: {e}"},
                                status_code=500)
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    return router
