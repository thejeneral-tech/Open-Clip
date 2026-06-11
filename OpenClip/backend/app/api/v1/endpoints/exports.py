"""Export retrieval & download."""
from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_current_user_flexible, get_session
from app.core.config import settings
from app.models.clip import Clip
from app.models.export import Export
from app.models.project import Project
from app.models.user import User
from app.models.video import Video
from app.schemas.export import ExportOut
from app.services.storage import storage

router = APIRouter()


async def _owned_export(db: AsyncSession, export_id: int, user: User) -> Export:
    export = await db.get(Export, export_id)
    if not export:
        raise HTTPException(status_code=404, detail="Export not found")
    clip = await db.get(Clip, export.clip_id)
    video = await db.get(Video, clip.video_id) if clip else None
    project = await db.get(Project, video.project_id) if video else None
    if not project or project.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Export not found")
    return export


@router.get("/exports/{export_id}", response_model=ExportOut)
async def get_export(
    export_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Export:
    return await _owned_export(db, export_id, current_user)


@router.get("/exports/{export_id}/download")
async def download_export(
    export_id: int,
    # Opened as a plain browser link, so accept ?token= as well as the header.
    current_user: User = Depends(get_current_user_flexible),
    db: AsyncSession = Depends(get_session),
):
    export = await _owned_export(db, export_id, current_user)
    if not export.storage_path:
        raise HTTPException(status_code=409, detail="Export not ready")

    filename = f"clip_{export.clip_id}_{export.resolution}.{export.format}"
    if settings.STORAGE_BACKEND == "s3":
        return RedirectResponse(url=storage.url(export.storage_path))

    path = storage.abspath(export.storage_path, ensure_parent=False)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Export file missing")
    media_type = "video/mp4" if export.format == "mp4" else "video/quicktime"
    return FileResponse(path, media_type=media_type, filename=filename)
