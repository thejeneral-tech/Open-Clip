"""In-process bot scheduler.

A small asyncio loop hosted by the FastAPI process. Every
``BOT_SCHEDULER_INTERVAL_SECONDS`` it:

* dispatches a cycle for each ``active`` bot whose ``next_run_at`` is due and that
  has no in-flight run (bumping ``next_run_at`` forward *before* dispatch so a
  slow worker never causes a double-fire), and
* releases ``scheduled`` publishing jobs whose ``scheduled_at`` has arrived.

This deliberately reuses the always-on API process instead of requiring a
separate ``celery beat`` service — keeping the "reuse existing infrastructure"
promise. It is safe to disable with ``BOT_SCHEDULER_ENABLED=false`` (e.g. when
running multiple API replicas, point exactly one at the scheduler).
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from sqlalchemy import or_, select

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.logging import get_logger
from app.models.bot import Bot, BotRun
from app.models.enums import BotRunTrigger, BotStatus, PublishStatus
from app.models.publishing import PublishingJob

logger = get_logger(__name__)

_task: asyncio.Task | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _dispatch_due_bots() -> int:
    from app.services import bot_runner

    dispatched = 0
    async with AsyncSessionLocal() as db:
        now = _now()
        rows = (
            await db.execute(
                select(Bot).where(
                    Bot.status == BotStatus.ACTIVE.value,
                    or_(Bot.next_run_at.is_(None), Bot.next_run_at <= now),
                )
            )
        ).scalars().all()
        for bot in rows:
            if not bot_runner.is_within_active_window(bot.schedule_config or {}, now):
                bot.next_run_at = bot_runner.compute_next_run(bot.schedule_config or {}, now)
                continue
            # Skip if a run is already pending/running.
            inflight = (
                await db.execute(
                    select(BotRun.id).where(
                        BotRun.bot_id == bot.id, BotRun.status.in_(["pending", "running"])
                    )
                )
            ).first()
            if inflight:
                continue
            run = BotRun(bot_id=bot.id, status="pending", trigger=BotRunTrigger.SCHEDULE.value,
                         stage="queued")
            db.add(run)
            await db.flush()
            # Bump forward *now* so the next tick won't re-dispatch this bot.
            bot.next_run_at = bot_runner.compute_next_run(bot.schedule_config or {}, now)
            run_id = run.id
            await db.commit()
            _enqueue_cycle(run_id)
            dispatched += 1
    return dispatched


async def _release_due_publishes() -> int:
    released = 0
    async with AsyncSessionLocal() as db:
        now = _now()
        rows = (
            await db.execute(
                select(PublishingJob).where(
                    PublishingJob.status == PublishStatus.SCHEDULED.value,
                    PublishingJob.scheduled_at <= now,
                )
            )
        ).scalars().all()
        for job in rows:
            job.status = PublishStatus.QUEUED.value
            job_id = job.id
            await db.commit()
            _enqueue_publish(job_id)
            released += 1
    return released


def _enqueue_cycle(run_id: int) -> None:
    from app.workers.bot_tasks import run_bot_cycle

    run_bot_cycle.apply_async((run_id,))


def _enqueue_publish(job_id: int) -> None:
    from app.workers.bot_tasks import publish_clip_job

    publish_clip_job.apply_async((job_id,))


async def _loop() -> None:
    interval = max(15, settings.BOT_SCHEDULER_INTERVAL_SECONDS)
    logger.info("Bot scheduler started (every %ss)", interval)
    while True:
        try:
            bots = await _dispatch_due_bots()
            pubs = await _release_due_publishes()
            if bots or pubs:
                logger.info("Scheduler tick: dispatched %d cycles, released %d publishes",
                            bots, pubs)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - never let the loop die
            logger.warning("Scheduler tick failed: %s", exc)
        await asyncio.sleep(interval)


def start_scheduler() -> None:
    global _task
    if not settings.BOT_SCHEDULER_ENABLED:
        logger.info("Bot scheduler disabled (BOT_SCHEDULER_ENABLED=false)")
        return
    if _task and not _task.done():
        return
    _task = asyncio.create_task(_loop())


async def stop_scheduler() -> None:
    global _task
    if _task and not _task.done():
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
    _task = None
