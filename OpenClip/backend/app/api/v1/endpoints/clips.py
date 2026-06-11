"""Clip listing, editing (timeline editor), regeneration, and exports."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.models.clip import Clip
from app.models.enums import JobStatus
from app.models.export import Export
from app.models.project import Project
from app.models.user import User
from app.models.video import Video
from app.schemas.clip import ClipOut, ClipRegenerateRequest, ClipUpdate
from app.schemas.common import Message, TaskResponse
from app.schemas.export import ExportCreate, ExportOut
from app.services import captions as captions_svc
from app.services.storage import storage

router = APIRouter()


async def _owned_clip(db: AsyncSession, clip_id: int, user: User) -> Clip:
    clip = await db.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    video = await db.get(Video, clip.video_id)
    project = await db.get(Project, video.project_id) if video else None
    if not project or project.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Clip not found")
    return clip


def _clip_out(clip: Clip) -> ClipOut:
    out = ClipOut.model_validate(clip)
    out.preview_path = storage.url(clip.preview_path)
    out.thumbnail_path = storage.url(clip.thumbnail_path)
    return out


@router.get("/videos/{video_id}/clips", response_model=list[ClipOut])
async def list_clips(
    video_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
    sort: str = "score",
) -> list[ClipOut]:
    video = await db.get(Video, video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")
    project = await db.get(Project, video.project_id)
    if not project or project.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Video not found")

    order = Clip.ranking_score.desc() if sort == "score" else Clip.start_time.asc()
    result = await db.execute(select(Clip).where(Clip.video_id == video_id).order_by(order))
    return [_clip_out(c) for c in result.scalars().all()]


@router.get("/clips/{clip_id}", response_model=ClipOut)
async def get_clip(
    clip_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> ClipOut:
    clip = await _owned_clip(db, clip_id, current_user)
    return _clip_out(clip)


@router.patch("/clips/{clip_id}", response_model=ClipOut)
async def update_clip(
    clip_id: int,
    payload: ClipUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> ClipOut:
    clip = await _owned_clip(db, clip_id, current_user)
    needs_render = False

    if payload.title is not None:
        clip.title = payload.title
    if payload.description is not None:
        clip.description = payload.description
    if payload.start_time is not None or payload.end_time is not None:
        clip.start_time = payload.start_time if payload.start_time is not None else clip.start_time
        clip.end_time = payload.end_time if payload.end_time is not None else clip.end_time
        if clip.end_time <= clip.start_time:
            raise HTTPException(status_code=400, detail="end_time must be after start_time")
        clip.duration = clip.end_time - clip.start_time
        needs_render = True
    if payload.aspect_ratio is not None:
        clip.aspect_ratio = payload.aspect_ratio.value
        needs_render = True
    if payload.caption_style is not None:
        clip.caption_style = payload.caption_style.value
        needs_render = True
    if payload.captions is not None:
        clip.captions = payload.captions
        needs_render = True
    if payload.reframe_data is not None:
        clip.reframe_data = payload.reframe_data
        needs_render = True
    if payload.order_index is not None:
        clip.order_index = payload.order_index

    await db.commit()
    await db.refresh(clip)

    if needs_render:
        from app.workers.tasks import render_preview_task

        clip.status = JobStatus.QUEUED.value
        await db.commit()
        render_preview_task.delay(clip.id)

    return _clip_out(clip)


@router.post("/clips/{clip_id}/regenerate", response_model=TaskResponse)
async def regenerate_clip(
    clip_id: int,
    payload: ClipRegenerateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TaskResponse:
    clip = await _owned_clip(db, clip_id, current_user)
    from app.workers.tasks import regenerate_clip_task

    task = regenerate_clip_task.delay(clip.id, payload.model_dump())
    return TaskResponse(task_id=task.id, detail="Regeneration queued")


@router.post("/clips/{clip_id}/render", response_model=TaskResponse)
async def render_clip_preview(
    clip_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TaskResponse:
    clip = await _owned_clip(db, clip_id, current_user)
    from app.workers.tasks import render_preview_task

    clip.status = JobStatus.QUEUED.value
    await db.commit()
    task = render_preview_task.delay(clip.id)
    return TaskResponse(task_id=task.id, detail="Preview render queued")


@router.delete("/clips/{clip_id}", response_model=Message)
async def delete_clip(
    clip_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    clip = await _owned_clip(db, clip_id, current_user)
    await db.delete(clip)
    await db.commit()
    return Message(detail="Clip deleted")


# ------------------------------------------------------------------ captions
@router.get("/clips/{clip_id}/captions.srt")
async def download_srt(
    clip_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Response:
    clip = await _owned_clip(db, clip_id, current_user)
    srt = captions_svc.render_srt(clip.captions or [])
    return Response(content=srt, media_type="application/x-subrip",
                    headers={"Content-Disposition": f'attachment; filename="clip_{clip_id}.srt"'})


@router.get("/clips/{clip_id}/captions.vtt")
async def download_vtt(
    clip_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Response:
    clip = await _owned_clip(db, clip_id, current_user)
    vtt = captions_svc.render_vtt(clip.captions or [])
    return Response(content=vtt, media_type="text/vtt",
                    headers={"Content-Disposition": f'attachment; filename="clip_{clip_id}.vtt"'})


# ------------------------------------------------------------------- exports
@router.get("/clips/{clip_id}/exports", response_model=list[ExportOut])
async def list_exports(
    clip_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[Export]:
    await _owned_clip(db, clip_id, current_user)
    result = await db.execute(
        select(Export).where(Export.clip_id == clip_id).order_by(Export.created_at.desc())
    )
    return list(result.scalars().all())


@router.post("/clips/{clip_id}/exports", response_model=ExportOut, status_code=201)
async def create_export(
    clip_id: int,
    payload: ExportCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Export:
    clip = await _owned_clip(db, clip_id, current_user)
    export = Export(
        clip_id=clip.id,
        format=payload.format.value,
        resolution=payload.resolution.value,
        aspect_ratio=payload.aspect_ratio.value,
        burn_captions=payload.burn_captions,
        status=JobStatus.QUEUED.value,
    )
    db.add(export)
    await db.commit()
    await db.refresh(export)

    from app.workers.tasks import export_clip_task

    task = export_clip_task.delay(export.id)
    export.celery_task_id = task.id
    await db.commit()
    await db.refresh(export)
    return export
