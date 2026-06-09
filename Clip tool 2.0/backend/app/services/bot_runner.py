"""Bot cycle orchestration logic (framework-agnostic, sync-session).

These helpers contain the *what* of an autonomous cycle — discover, score,
approve, plan ingestion, build pipeline options, schedule, and finalise into
publishing jobs. The Celery tasks in :mod:`app.workers.bot_tasks` provide the
*when* (queueing, retries, progress). Splitting them keeps the decision logic
unit-testable without a broker.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.logging import get_logger
from app.models.bot import Bot
from app.models.clip import Clip
from app.models.enums import (
    ApprovalMode,
    JobStatus,
    PublishStatus,
    SourceListMode,
    TrendItemStatus,
    VideoSource,
)
from app.models.project import Project
from app.models.publishing import PublishingConnector, PublishingJob
from app.models.trend import TrendItem, TrendSource
from app.models.video import Video
from app.services import scoring
from app.services.discovery import discover_source
from app.services.discovery.base import DiscoveredItem
from app.services.ollama_service import ollama_service

logger = get_logger(__name__)


# ----------------------------------------------------------------- utilities
def _now() -> datetime:
    return datetime.now(timezone.utc)


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def ensure_bot_project(db: Session, bot: Bot) -> Project:
    """Each bot writes its videos/clips into a dedicated project (reusing the
    whole existing project→video→clip→export stack)."""
    if bot.project_id:
        proj = db.get(Project, bot.project_id)
        if proj:
            return proj
    proj = Project(owner_id=bot.owner_id, name=f"🤖 {bot.name}",
                   description=f"Auto-generated content for bot #{bot.id}")
    db.add(proj)
    db.flush()
    bot.project_id = proj.id
    return proj


# --------------------------------------------------------------- source rules
def select_sources(db: Session, bot: Bot) -> list[TrendSource]:
    """Resolve which sources a cycle should poll, honoring the bot's source_mode.

    * whitelist → only ``allow`` sources
    * blacklist → all enabled sources except platforms with a ``deny`` entry
    * hybrid    → allow sources plus any enabled source not explicitly denied
    """
    rows = db.execute(
        select(TrendSource).where(TrendSource.bot_id == bot.id, TrendSource.enabled.is_(True))
    ).scalars().all()
    mode = (bot.discovery_config or {}).get("source_mode", "hybrid")
    allow = [s for s in rows if s.list_mode == SourceListMode.ALLOW.value]
    deny_ids = {s.identifier for s in rows if s.list_mode == SourceListMode.DENY.value}
    if mode == "whitelist":
        return allow
    if mode == "blacklist":
        return [s for s in rows if s.list_mode != SourceListMode.DENY.value
                and s.identifier not in deny_ids]
    return [s for s in rows if s.list_mode == SourceListMode.ALLOW.value
            or s.identifier not in deny_ids]


# ------------------------------------------------------------------ discovery
def run_discovery(db: Session, bot: Bot) -> list[TrendItem]:
    """Poll sources, filter, dedupe, and persist new :class:`TrendItem` rows."""
    disc_cfg = bot.discovery_config or {}
    filters = bot.filter_config or {}
    limit = int(disc_cfg.get("max_items_per_source", 25))
    lookback = int(disc_cfg.get("lookback_hours", 168))

    existing = set(
        db.execute(select(TrendItem.external_id).where(TrendItem.bot_id == bot.id)).scalars()
    )
    created: list[TrendItem] = []
    for source in select_sources(db, bot):
        found = discover_source(source, limit=limit, lookback_hours=lookback)
        source.last_polled_at = _now()
        for d in found:
            if d.external_id in existing:
                continue
            ok, reason = scoring.passes_filters(d, filters)
            existing.add(d.external_id)
            item = TrendItem(
                source_id=source.id,
                bot_id=bot.id,
                **d.to_row(),
                status=(TrendItemStatus.DISCOVERED.value if ok else TrendItemStatus.REJECTED.value),
                reason=None if ok else reason,
            )
            db.add(item)
            if ok:
                created.append(item)
    db.flush()
    return created


# -------------------------------------------------------------------- scoring
def _to_discovered(item: TrendItem) -> DiscoveredItem:
    return DiscoveredItem(
        platform=item.platform, external_id=item.external_id, url=item.url,
        title=item.title, author=item.author, description=item.description,
        thumbnail_url=item.thumbnail_url, language=item.language,
        duration_seconds=item.duration_seconds, published_at=item.published_at,
        metrics=item.metrics or {},
    )


def run_scoring(db: Session, bot: Bot, items: list[TrendItem]) -> None:
    """Score each item locally; approve those at/above the configured threshold."""
    scfg = bot.scoring_config or {}
    filters = bot.filter_config or {}
    scfg = {**scfg, "max_age_hours": filters.get("max_age_hours", 720)}
    min_score = float(scfg.get("min_score", 55))
    use_llm = bool(scfg.get("use_llm_relevance", True))
    topic = bot.bot_type
    keywords = filters.get("keywords", [])
    insights = bot.insights or {}
    hist_default = 50.0

    for item in items:
        d = _to_discovered(item)
        relevance = None
        if use_llm:
            relevance = scoring.llm_relevance(
                d, topic=topic, keywords=keywords, assignments=bot.model_assignments
            )
        score, breakdown = scoring.score_item(
            d, scoring_config=scfg, relevance=relevance, historical=hist_default
        )
        item.trend_score = score
        item.score_breakdown = breakdown
        approved = score >= min_score
        item.status = (
            TrendItemStatus.APPROVED.value if approved else TrendItemStatus.SCORED.value
        )
        if not approved:
            item.reason = f"score {score} < threshold {min_score}"
    db.flush()


# ------------------------------------------------------------ ingestion plan
def plan_ingestion(db: Session, bot: Bot) -> list[TrendItem]:
    """Top approved-but-not-yet-ingested items, capped by schedule + global safety."""
    sched = bot.schedule_config or {}
    cap = int(sched.get("max_videos_per_run", settings.BOT_MAX_VIDEOS_PER_RUN))
    cap = max(0, min(cap, settings.BOT_MAX_VIDEOS_PER_RUN))
    rows = db.execute(
        select(TrendItem)
        .where(
            TrendItem.bot_id == bot.id,
            TrendItem.status == TrendItemStatus.APPROVED.value,
            TrendItem.video_id.is_(None),
        )
        .order_by(TrendItem.trend_score.desc())
        .limit(cap)
    ).scalars().all()
    return list(rows)


def build_process_options(bot: Bot) -> dict[str, Any]:
    """Map the bot's clipping config onto the existing ProcessOptions schema."""
    c = bot.clipping_config or {}
    assignments = bot.model_assignments or {}
    model = ollama_service.resolve_model("clip_selection", assignments)
    return {
        "target_clip_count": int(c.get("target_clip_count", 8)),
        "min_clip_seconds": int(c.get("min_clip_seconds", 12)),
        "max_clip_seconds": int(c.get("max_clip_seconds", 60)),
        "aspect_ratios": c.get("aspect_ratios", ["9:16"]),
        "caption_style": c.get("caption_style", "hormozi"),
        "generate_titles": bool(c.get("generate_titles", True)),
        "generate_descriptions": bool(c.get("generate_descriptions", True)),
        "generate_broll": bool(c.get("generate_broll", False)),
        "enable_reframe": bool(c.get("enable_reframe", True)),
        "enable_captions": bool(c.get("enable_captions", True)),
        "model": model,
    }


def create_bot_video(db: Session, bot: Bot, item: TrendItem) -> Video:
    project = ensure_bot_project(db, bot)
    video = Video(
        project_id=project.id,
        source=VideoSource.YOUTUBE.value,
        source_url=item.url,
        title=item.title,
        status=JobStatus.QUEUED.value,
        stage="downloading",
    )
    db.add(video)
    db.flush()
    item.video_id = video.id
    item.status = TrendItemStatus.INGESTING.value
    return video


# ----------------------------------------------------------------- scheduling
def is_within_active_window(sched: dict[str, Any], now: datetime | None = None) -> bool:
    now = now or _now()
    days = sched.get("days")           # 0=Mon … 6=Sun
    hours = sched.get("hours")         # active hours [0-23]
    quiet = sched.get("quiet_hours", [])
    if days and now.weekday() not in days:
        return False
    if hours and now.hour not in hours:
        return False
    if quiet and now.hour in quiet:
        return False
    return True


def compute_next_run(sched: dict[str, Any], now: datetime | None = None) -> datetime:
    """Next eligible run time given an interval + active-window constraints."""
    now = now or _now()
    interval = max(5, int(sched.get("interval_minutes", 360)))
    candidate = now + timedelta(minutes=interval)
    # Nudge forward (hour by hour, up to a week) into the next active window.
    for _ in range(168):
        if is_within_active_window(sched, candidate):
            return candidate
        candidate += timedelta(hours=1)
    return candidate


# ------------------------------------------------------------------- finalise
def _connectors_for(db: Session, bot: Bot, platform: str) -> PublishingConnector | None:
    return db.execute(
        select(PublishingConnector).where(
            PublishingConnector.platform == platform,
            (PublishingConnector.bot_id == bot.id) | (PublishingConnector.bot_id.is_(None)),
        ).order_by(PublishingConnector.bot_id.is_(None))  # prefer bot-specific
    ).scalars().first()


def finalize_item(db: Session, bot: Bot, item: TrendItem) -> list[PublishingJob]:
    """Turn a processed video's clips into publishing jobs per the approval mode.

    Returns jobs that are ready to dispatch immediately (QUEUED). Manual/held
    jobs are persisted but not returned.
    """
    if not item.video_id:
        return []
    clips = db.execute(
        select(Clip).where(Clip.video_id == item.video_id, Clip.status == JobStatus.COMPLETED.value)
        .order_by(Clip.ranking_score.desc())
    ).scalars().all()
    if not clips:
        item.status = TrendItemStatus.FAILED.value
        item.reason = "no clips produced"
        return []

    pub_cfg = bot.publishing_config or {}
    platforms = pub_cfg.get("platforms") or ["manual"]
    threshold = float(pub_cfg.get("auto_publish_threshold", 80))
    spacing = int(pub_cfg.get("schedule_spacing_minutes", 120))
    mode = bot.approval_mode

    ready: list[PublishingJob] = []
    slot = 0
    for clip in clips:
        score = float(clip.ranking_score or clip.viral_score or 0)
        for platform in platforms:
            connector = _connectors_for(db, bot, platform)
            if mode == ApprovalMode.AUTONOMOUS.value:
                status = PublishStatus.SCHEDULED.value
            elif mode == ApprovalMode.SEMI_AUTO.value:
                status = (
                    PublishStatus.SCHEDULED.value if score >= threshold
                    else PublishStatus.AWAITING_APPROVAL.value
                )
            else:  # manual
                status = PublishStatus.AWAITING_APPROVAL.value

            scheduled_at = None
            if status == PublishStatus.SCHEDULED.value:
                scheduled_at = _now() + timedelta(minutes=spacing * slot)
                slot += 1
            job = PublishingJob(
                bot_id=bot.id, clip_id=clip.id,
                connector_id=connector.id if connector else None,
                platform=platform, status=status, scheduled_at=scheduled_at,
                title=clip.title, description=clip.description,
                payload={
                    "asset_key": clip.preview_path,
                    "hashtags": clip.hashtags or [],
                    "privacy": pub_cfg.get("privacy", "private"),
                    "score": score,
                },
            )
            db.add(job)
            if status == PublishStatus.SCHEDULED.value and scheduled_at and scheduled_at <= _now():
                ready.append(job)
    item.status = TrendItemStatus.PROCESSED.value
    db.flush()
    return ready
