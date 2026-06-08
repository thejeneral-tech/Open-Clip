"""Celery tasks for the autonomous bot layer.

Pipeline of an autonomous cycle:

    run_bot_cycle
      → discover + score + approve (inline, fast)
      → for each approved video, dispatch a chain:
            ingest_youtube_task → process_video_task → bot_finalize_item
      → bot_finalize_item turns finished clips into PublishingJobs
      → publish_clip_job delivers each scheduled job via its connector
    bot_self_improve aggregates performance into Bot.insights.

Discovery/downloads/publishing touch the network; everything else (transcription,
analysis, clipping, captions) is local and keeps working offline.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from celery import chain

from app.core.config import settings
from app.core.database import session_scope
from app.core.events import publish_progress
from app.core.logging import get_logger
from app.models.bot import Bot, BotRun
from app.models.clip import Clip
from app.models.enums import BotStatus, PublishStatus, TrendItemStatus
from app.models.publishing import PublishingConnector, PublishingJob
from app.models.trend import TrendItem
from app.services import analytics, bot_runner
from app.services.publishing import ConnectorNotConfigured, get_connector
from app.services.storage import storage
from app.workers.celery_app import celery_app
from app.workers.tasks import ingest_youtube_task, process_video_task

logger = get_logger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _run_event(run: BotRun, message: str, **data: Any) -> None:
    """Append a structured event to a run and emit a progress frame."""
    events = list(run.events or [])
    events.append({"ts": _now().isoformat(), "message": message, **data})
    run.events = events
    if run.stage:
        publish_progress("bot_run", run.id, stage=run.stage, progress=run.progress,
                         status=run.status, message=message, data=data)


# =====================================================================
# Cycle
# =====================================================================
@celery_app.task(bind=True, name="app.workers.bot_tasks.run_bot_cycle")
def run_bot_cycle(self, run_id: int) -> dict[str, Any]:
    with session_scope() as db:
        run = db.get(BotRun, run_id)
        if not run:
            return {"error": "run not found"}
        bot = db.get(Bot, run.bot_id)
        if not bot:
            run.status = "failed"
            run.error = "bot not found"
            return {"error": "bot not found"}

        run.status = "running"
        run.stage = "discovery"
        run.started_at = _now()
        run.progress = 0.05
        bot.status = BotStatus.RUNNING.value
        _run_event(run, "Cycle started")

        stats = {"discovered": 0, "scored": 0, "approved": 0, "dispatched": 0, "errors": 0}
        try:
            bot_runner.ensure_bot_project(db, bot)

            # --- discovery ---
            items = bot_runner.run_discovery(db, bot)
            stats["discovered"] = len(items)
            run.stage = "scoring"
            run.progress = 0.35
            _run_event(run, f"Discovered {len(items)} new items")

            # --- scoring + approval ---
            bot_runner.run_scoring(db, bot, items)
            stats["scored"] = len(items)
            approved = [i for i in items if i.status == TrendItemStatus.APPROVED.value]
            stats["approved"] = len(approved)
            run.stage = "ingest"
            run.progress = 0.6
            _run_event(run, f"Approved {len(approved)} items")

            # --- dispatch ingestion + processing chains ---
            picks = bot_runner.plan_ingestion(db, bot)
            opts = bot_runner.build_process_options(bot)
            dispatched: list[tuple[int, int, str]] = []
            for item in picks:
                video = bot_runner.create_bot_video(db, bot, item)
                dispatched.append((item.id, video.id, item.url))
            run.stats = stats
            run.stage = "processing"
            run.progress = 0.8
        except Exception as exc:
            logger.exception("Bot cycle %s discovery/scoring failed", run_id)
            run.status = "failed"
            run.error = str(exc)
            bot.status = BotStatus.ERROR.value
            bot.last_error = str(exc)
            stats["errors"] += 1
            run.stats = stats
            return {"run_id": run_id, "error": str(exc)}

    # Dispatch chains outside the transaction so ids are committed first.
    for item_id, video_id, url in dispatched:
        chain(
            ingest_youtube_task.s(video_id, url),
            process_video_task.si(video_id, opts),
            bot_finalize_item.si(item_id, run_id),
        ).apply_async()

    with session_scope() as db:
        run = db.get(BotRun, run_id)
        bot = db.get(Bot, run.bot_id)
        stats["dispatched"] = len(dispatched)
        run.stats = stats
        run.progress = 1.0
        run.status = "completed"
        run.stage = "done"
        run.finished_at = _now()
        _run_event(run, f"Dispatched {len(dispatched)} videos for processing")
        bot.status = BotStatus.ACTIVE.value
        bot.last_run_at = _now()
        bot.last_error = None
        bot.next_run_at = bot_runner.compute_next_run(bot.schedule_config or {})
        # Roll counters into the bot's lifetime stats.
        agg = dict(bot.stats or {})
        for k, v in stats.items():
            agg[k] = agg.get(k, 0) + v
        agg["runs"] = agg.get("runs", 0) + 1
        bot.stats = agg
    return {"run_id": run_id, **stats}


# =====================================================================
# Finalise a processed video → publishing jobs
# =====================================================================
@celery_app.task(bind=True, name="app.workers.bot_tasks.bot_finalize_item")
def bot_finalize_item(self, item_id: int, run_id: int | None = None) -> dict[str, Any]:
    ready_ids: list[int] = []
    with session_scope() as db:
        item = db.get(TrendItem, item_id)
        if not item:
            return {"error": "item not found"}
        bot = db.get(Bot, item.bot_id)
        ready = bot_runner.finalize_item(db, bot, item)
        ready_ids = [j.id for j in ready]
        clip_count = (
            db.query(Clip).filter(Clip.video_id == item.video_id).count() if item.video_id else 0
        )
        if run_id:
            run = db.get(BotRun, run_id)
            if run:
                rstats = dict(run.stats or {})
                rstats["clips_created"] = rstats.get("clips_created", 0) + clip_count
                rstats["queued"] = rstats.get("queued", 0) + len(ready_ids)
                run.stats = rstats

    for jid in ready_ids:
        publish_clip_job.apply_async((jid,))
    return {"item_id": item_id, "queued": len(ready_ids)}


# =====================================================================
# Publish a single clip via its connector
# =====================================================================
@celery_app.task(bind=True, name="app.workers.bot_tasks.publish_clip_job", max_retries=2)
def publish_clip_job(self, job_id: int) -> dict[str, Any]:
    with session_scope() as db:
        job = db.get(PublishingJob, job_id)
        if not job:
            return {"error": "job not found"}
        if job.status in (PublishStatus.PUBLISHED.value, PublishStatus.CANCELLED.value):
            return {"job_id": job_id, "status": job.status}
        clip = db.get(Clip, job.clip_id)
        connector_row = db.get(PublishingConnector, job.connector_id) if job.connector_id else None
        asset_key = (job.payload or {}).get("asset_key") or (clip.preview_path if clip else None)
        asset_path = storage.abspath(asset_key, ensure_parent=False) if asset_key else None
        clip_video_id = clip.video_id if clip else None
        platform = job.platform
        job.status = PublishStatus.PUBLISHING.value
        # Detach so the connector can read payload/title/description after commit
        # (expire_on_commit=False keeps the loaded attributes populated).
        db.expunge(job)
        if connector_row is not None:
            db.expunge(connector_row)

    plugin = get_connector(platform) or get_connector("manual")
    try:
        if connector_row is not None:
            ok, detail = plugin.validate(connector_row)
            if not ok:
                raise ConnectorNotConfigured(detail)
        result = plugin.publish(job, asset_path or "", connector_row)
    except ConnectorNotConfigured as exc:
        with session_scope() as db:
            j = db.get(PublishingJob, job_id)
            j.status = PublishStatus.AWAITING_APPROVAL.value
            j.error = str(exc)
        logger.info("Publish job %s needs setup: %s", job_id, exc)
        return {"job_id": job_id, "status": "awaiting_approval", "detail": str(exc)}
    except Exception as exc:
        logger.exception("Publish job %s failed", job_id)
        with session_scope() as db:
            j = db.get(PublishingJob, job_id)
            j.status = PublishStatus.FAILED.value
            j.error = str(exc)
            j.retries = (j.retries or 0) + 1
        raise

    with session_scope() as db:
        j = db.get(PublishingJob, job_id)
        if result.success:
            j.status = PublishStatus.PUBLISHED.value
            j.published_at = _now()
            j.external_post_id = result.external_post_id
            j.external_url = result.external_url
            j.error = None
            # Seed an analytics row so the learning loop has a record to grow.
            if j.bot_id:
                analytics.record_metric(
                    db, bot_id=j.bot_id, scope="clip", ref_id=j.clip_id,
                    platform=j.platform, metrics={}, recorded_at=_now(),
                )
            if clip_video_id:
                it = db.query(TrendItem).filter(TrendItem.video_id == clip_video_id).first()
                if it:
                    it.status = TrendItemStatus.PUBLISHED.value
        else:
            j.status = PublishStatus.FAILED.value
            j.error = result.detail
    return {"job_id": job_id, "status": "published" if result.success else "failed",
            "url": result.external_url}


# =====================================================================
# Self-improvement
# =====================================================================
@celery_app.task(bind=True, name="app.workers.bot_tasks.bot_self_improve")
def bot_self_improve(self, bot_id: int) -> dict[str, Any]:
    with session_scope() as db:
        bot = db.get(Bot, bot_id)
        if not bot:
            return {"error": "bot not found"}
        insights = analytics.run_self_improvement(db, bot)
    return {"bot_id": bot_id, "recommendations": (insights or {}).get("recommendations", [])}
