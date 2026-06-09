"""Video ingestion & processing endpoints."""
from __future__ import annotations

import os

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.core.config import settings
from app.core.events import get_latest_snapshot
from app.models.clip import Clip
from app.models.enums import JobStatus, VideoSource
from app.models.project import Project
from app.models.transcript import Transcript
from app.models.user import User
from app.models.video import Video
from app.schemas.common import Message, TaskResponse
from app.schemas.transcript import TranscriptOut
from app.schemas.video import ProcessOptions, VideoOut, YouTubeImportRequest
from app.services.storage import storage, video_source_key

router = APIRouter()

_CHUNK = 1024 * 1024 * 4  # 4 MB


async def _owned_project(db: AsyncSession, project_id: int, user: User) -> Project:
    project = await db.get(Project, project_id)
    if not project or project.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


async def _owned_video(db: AsyncSession, video_id: int, user: User) -> Video:
    video = await db.get(Video, video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")
    project = await db.get(Project, video.project_id)
    if not project or project.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Video not found")
    return video


async def _to_out(db: AsyncSession, video: Video) -> VideoOut:
    count = (
        await db.execute(select(func.count(Clip.id)).where(Clip.video_id == video.id))
    ).scalar_one()
    out = VideoOut.model_validate(video)
    out.thumbnail_path = storage.url(video.thumbnail_path)
    out.clip_count = count
    return out


@router.get("/projects/{project_id}/videos", response_model=list[VideoOut])
async def list_videos(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[VideoOut]:
    await _owned_project(db, project_id, current_user)
    result = await db.execute(
        select(Video).where(Video.project_id == project_id).order_by(Video.created_at.desc())
    )
    return [await _to_out(db, v) for v in result.scalars().all()]


@router.post("/projects/{project_id}/videos/upload", response_model=VideoOut, status_code=201)
async def upload_video(
    project_id: int,
    file: UploadFile = File(...),
    title: str | None = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> VideoOut:
    await _owned_project(db, project_id, current_user)

    ext = (os.path.splitext(file.filename or "")[1] or ".mp4").lstrip(".").lower()
    if ext not in {"mp4", "mov", "mkv", "webm", "avi", "m4v"}:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: .{ext}")

    video = Video(
        project_id=project_id,
        source=VideoSource.UPLOAD.value,
        original_filename=file.filename,
        title=title or file.filename,
        status=JobStatus.PENDING.value,
        stage="uploading",
    )
    db.add(video)
    await db.flush()  # assign id

    key = video_source_key(project_id, video.id, ext)
    dest = storage.open_write(key)
    written = 0
    limit = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
    with open(dest, "wb") as out:
        while chunk := await file.read(_CHUNK):
            written += len(chunk)
            if written > limit:
                out.close()
                storage.delete(key)
                raise HTTPException(status_code=413, detail="File too large")
            out.write(chunk)
    storage.commit(key)

    video.storage_path = key
    video.size_bytes = written
    video.status = JobStatus.QUEUED.value
    video.stage = "ingest"
    await db.commit()
    await db.refresh(video)

    from app.workers.tasks import ingest_upload_task

    task = ingest_upload_task.delay(video.id)
    video.celery_task_id = task.id
    await db.commit()
    return await _to_out(db, video)


@router.post("/projects/{project_id}/videos/youtube", response_model=VideoOut, status_code=201)
async def import_youtube(
    project_id: int,
    payload: YouTubeImportRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> VideoOut:
    await _owned_project(db, project_id, current_user)
    video = Video(
        project_id=project_id,
        source=VideoSource.YOUTUBE.value,
        source_url=str(payload.url),
        title=payload.title,
        status=JobStatus.QUEUED.value,
        stage="fetching",
    )
    db.add(video)
    await db.commit()
    await db.refresh(video)

    from app.workers.tasks import ingest_youtube_task

    task = ingest_youtube_task.delay(video.id, str(payload.url))
    video.celery_task_id = task.id
    await db.commit()
    return await _to_out(db, video)


@router.get("/videos/{video_id}", response_model=VideoOut)
async def get_video(
    video_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> VideoOut:
    video = await _owned_video(db, video_id, current_user)
    return await _to_out(db, video)


@router.get("/videos/{video_id}/status")
async def video_status(
    video_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    video = await _owned_video(db, video_id, current_user)
    snapshot = get_latest_snapshot("video", video_id)
    return {
        "id": video.id,
        "status": video.status,
        "stage": video.stage,
        "progress": video.progress,
        "error": video.error,
        "live": snapshot,
    }


@router.get("/videos/{video_id}/transcript", response_model=TranscriptOut)
async def get_transcript(
    video_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Transcript:
    await _owned_video(db, video_id, current_user)
    result = await db.execute(select(Transcript).where(Transcript.video_id == video_id))
    transcript = result.scalar_one_or_none()
    if not transcript:
        raise HTTPException(status_code=404, detail="Transcript not ready")
    return transcript


@router.post("/videos/{video_id}/process", response_model=TaskResponse)
async def process_video(
    video_id: int,
    options: ProcessOptions | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TaskResponse:
    video = await _owned_video(db, video_id, current_user)
    if video.status == JobStatus.PROCESSING.value:
        raise HTTPException(status_code=409, detail="Video is already processing")
    # Ready = source bytes on disk (uploads / full-download YouTube) OR a fetched
    # YouTube analytics bundle (segment mode downloads the clip segments later).
    ingested = bool(video.storage_path) or (
        video.source == VideoSource.YOUTUBE.value and bool(video.youtube_meta)
    )
    if not ingested:
        raise HTTPException(status_code=409, detail="Video is not ready (still ingesting)")

    opts = (options or ProcessOptions()).model_dump(mode="json")
    video.status = JobStatus.QUEUED.value
    video.stage = "queued"
    video.progress = 0.0
    video.error = None
    await db.commit()

    from app.workers.tasks import process_video_task

    task = process_video_task.delay(video.id, opts)
    video.celery_task_id = task.id
    await db.commit()
    return TaskResponse(task_id=task.id, detail="Processing started")


@router.delete("/videos/{video_id}", response_model=Message)
async def delete_video(
    video_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    video = await _owned_video(db, video_id, current_user)
    # Best-effort media cleanup.
    from app.services.storage import video_dir

    storage.delete(video_dir(video.project_id, video.id))
    await db.delete(video)
    await db.commit()
    return Message(detail="Video deleted")
