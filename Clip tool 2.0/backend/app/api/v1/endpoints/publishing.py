"""Publishing API: connectors + the publish queue (approve / cancel / retry)."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.models.bot import Bot
from app.models.clip import Clip
from app.models.enums import ConnectorStatus, PublishStatus
from app.models.publishing import PublishingConnector, PublishingJob
from app.models.user import User
from app.schemas.common import Message, TaskResponse
from app.schemas.publishing import (
    ConnectorCreate,
    ConnectorOut,
    ConnectorUpdate,
    PublishingJobOut,
    PublishJobCreate,
)

router = APIRouter()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _connector_out(c: PublishingConnector) -> ConnectorOut:
    out = ConnectorOut.model_validate(c)
    out.has_credentials = bool(c.credentials)
    return out


async def _owned_connector(db: AsyncSession, cid: int, user: User) -> PublishingConnector:
    c = await db.get(PublishingConnector, cid)
    if not c or c.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Connector not found")
    return c


async def _owned_job(db: AsyncSession, jid: int, user: User) -> PublishingJob:
    job = await db.get(PublishingJob, jid)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.bot_id is not None:
        bot = await db.get(Bot, job.bot_id)
        if not bot or bot.owner_id != user.id:
            raise HTTPException(status_code=404, detail="Job not found")
    return job


# --------------------------------------------------------------- connectors
@router.get("/connectors", response_model=list[ConnectorOut])
async def list_connectors(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[ConnectorOut]:
    rows = (
        await db.execute(
            select(PublishingConnector).where(PublishingConnector.owner_id == current_user.id)
            .order_by(PublishingConnector.created_at.desc())
        )
    ).scalars().all()
    return [_connector_out(c) for c in rows]


@router.post("/connectors", response_model=ConnectorOut, status_code=201)
async def create_connector(
    payload: ConnectorCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> ConnectorOut:
    c = PublishingConnector(
        owner_id=current_user.id,
        bot_id=payload.bot_id,
        platform=payload.platform.value,
        name=payload.name,
        config=payload.config,
        credentials=payload.credentials,
        status=ConnectorStatus.CONNECTED.value if payload.credentials else ConnectorStatus.DISCONNECTED.value,
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return _connector_out(c)


@router.patch("/connectors/{connector_id}", response_model=ConnectorOut)
async def update_connector(
    connector_id: int,
    payload: ConnectorUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> ConnectorOut:
    c = await _owned_connector(db, connector_id, current_user)
    if payload.name is not None:
        c.name = payload.name
    if payload.config is not None:
        c.config = payload.config
    if payload.credentials is not None:
        c.credentials = payload.credentials
        c.status = ConnectorStatus.CONNECTED.value if payload.credentials else ConnectorStatus.DISCONNECTED.value
    if payload.bot_id is not None:
        c.bot_id = payload.bot_id
    await db.commit()
    await db.refresh(c)
    return _connector_out(c)


@router.delete("/connectors/{connector_id}", response_model=Message)
async def delete_connector(
    connector_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    c = await _owned_connector(db, connector_id, current_user)
    await db.delete(c)
    await db.commit()
    return Message(detail="Connector deleted")


# ------------------------------------------------------------------- queue
@router.get("/jobs", response_model=list[PublishingJobOut])
async def list_jobs(
    bot_id: int | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[PublishingJobOut]:
    # Scope to bots the user owns.
    owned_bot_ids = (
        await db.execute(select(Bot.id).where(Bot.owner_id == current_user.id))
    ).scalars().all()
    stmt = select(PublishingJob).where(PublishingJob.bot_id.in_(owned_bot_ids or [-1]))
    if bot_id is not None:
        stmt = stmt.where(PublishingJob.bot_id == bot_id)
    if status:
        stmt = stmt.where(PublishingJob.status == status)
    stmt = stmt.order_by(PublishingJob.created_at.desc()).limit(limit)
    rows = (await db.execute(stmt)).scalars().all()
    return [PublishingJobOut.model_validate(r) for r in rows]


@router.post("/jobs", response_model=PublishingJobOut, status_code=201)
async def create_job(
    payload: PublishJobCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> PublishingJobOut:
    clip = await db.get(Clip, payload.clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    platform = payload.platform.value if hasattr(payload.platform, "value") else payload.platform
    job = PublishingJob(
        clip_id=clip.id,
        connector_id=payload.connector_id,
        platform=platform,
        status=PublishStatus.PENDING.value,
        scheduled_at=payload.scheduled_at,
        title=payload.title or clip.title,
        description=payload.description or clip.description,
        payload={"asset_key": clip.preview_path, "hashtags": clip.hashtags or [], **payload.payload},
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return PublishingJobOut.model_validate(job)


@router.post("/jobs/{job_id}/approve", response_model=TaskResponse)
async def approve_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TaskResponse:
    job = await _owned_job(db, job_id, current_user)
    job.status = PublishStatus.QUEUED.value
    await db.commit()

    from app.workers.bot_tasks import publish_clip_job

    task = publish_clip_job.apply_async((job.id,))
    return TaskResponse(task_id=task.id, detail="Publishing")


@router.post("/jobs/{job_id}/retry", response_model=TaskResponse)
async def retry_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TaskResponse:
    job = await _owned_job(db, job_id, current_user)
    job.status = PublishStatus.QUEUED.value
    job.error = None
    await db.commit()

    from app.workers.bot_tasks import publish_clip_job

    task = publish_clip_job.apply_async((job.id,))
    return TaskResponse(task_id=task.id, detail="Retrying")


@router.post("/jobs/{job_id}/cancel", response_model=PublishingJobOut)
async def cancel_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> PublishingJobOut:
    job = await _owned_job(db, job_id, current_user)
    job.status = PublishStatus.CANCELLED.value
    await db.commit()
    await db.refresh(job)
    return PublishingJobOut.model_validate(job)
