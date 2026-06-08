"""Analytics aggregation + the self-improvement feedback loop.

Runs entirely on local data + a local model. It aggregates clip scores and
published-post performance into a compact summary, then asks the bot's reasoning
model what to change, persisting the result to :attr:`Bot.insights` so future
runs can bias toward what works.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.models.bot import Bot
from app.models.clip import Clip
from app.models.metrics import BotMetric
from app.models.publishing import PublishingJob
from app.models.trend import TrendItem
from app.models.video import Video
from app.services import bot_prompts
from app.services.ollama_service import ollama_service

logger = get_logger(__name__)


def record_metric(
    db: Session,
    *,
    bot_id: int,
    scope: str,
    ref_id: int | None,
    platform: str | None,
    metrics: dict[str, Any],
    recorded_at: datetime | None = None,
) -> BotMetric:
    row = BotMetric(
        bot_id=bot_id,
        scope=scope,
        ref_id=ref_id,
        platform=platform,
        metrics=metrics,
        recorded_at=recorded_at or datetime.now(timezone.utc),
    )
    db.add(row)
    return row


def _bot_clip_ids(db: Session, bot: Bot) -> list[int]:
    if not bot.project_id:
        return []
    rows = db.execute(
        select(Clip.id)
        .join(Video, Clip.video_id == Video.id)
        .where(Video.project_id == bot.project_id)
    ).scalars()
    return list(rows)


def aggregate_performance(db: Session, bot: Bot) -> dict[str, Any]:
    """Build a compact, model-friendly performance summary for ``bot``."""
    clip_ids = _bot_clip_ids(db, bot)
    summary: dict[str, Any] = {
        "total_clips": len(clip_ids),
        "length_buckets": {},
        "caption_styles": {},
        "top_clips": [],
        "published": {"total": 0, "by_platform": {}},
        "sources": {},
    }
    if clip_ids:
        clips = db.execute(select(Clip).where(Clip.id.in_(clip_ids))).scalars().all()
        for c in clips:
            bucket = f"{int(c.duration // 15) * 15}-{int(c.duration // 15) * 15 + 15}s"
            b = summary["length_buckets"].setdefault(bucket, {"count": 0, "avg_score": 0.0})
            b["count"] += 1
            b["avg_score"] += float(c.ranking_score or c.viral_score or 0)
            style = c.caption_style or "?"
            s = summary["caption_styles"].setdefault(style, {"count": 0, "avg_score": 0.0})
            s["count"] += 1
            s["avg_score"] += float(c.ranking_score or c.viral_score or 0)
        for b in summary["length_buckets"].values():
            b["avg_score"] = round(b["avg_score"] / max(1, b["count"]), 1)
        for s in summary["caption_styles"].values():
            s["avg_score"] = round(s["avg_score"] / max(1, s["count"]), 1)
        top = sorted(clips, key=lambda c: c.ranking_score or 0, reverse=True)[:5]
        summary["top_clips"] = [
            {"title": c.title, "score": c.ranking_score, "duration": round(c.duration, 1)}
            for c in top
        ]

    jobs = db.execute(
        select(PublishingJob).where(PublishingJob.bot_id == bot.id)
    ).scalars().all()
    pub = {"total": 0, "by_platform": {}, "by_hour": {}}
    for j in jobs:
        if j.status != "published":
            continue
        pub["total"] += 1
        pub["by_platform"][j.platform] = pub["by_platform"].get(j.platform, 0) + 1
        if j.published_at:
            hour = j.published_at.hour
            agg = pub["by_hour"].setdefault(str(hour), {"posts": 0, "views": 0})
            agg["posts"] += 1
            agg["views"] += int((j.analytics or {}).get("views", 0) or 0)
    summary["published"] = pub

    # Source performance: avg trend score of items per source name.
    items = db.execute(
        select(TrendItem).where(TrendItem.bot_id == bot.id)
    ).scalars().all()
    for it in items:
        name = (it.source.name if it.source else None) or it.platform
        agg = summary["sources"].setdefault(name, {"count": 0, "avg_score": 0.0, "published": 0})
        agg["count"] += 1
        agg["avg_score"] += float(it.trend_score or 0)
        if it.status == "published":
            agg["published"] += 1
    for agg in summary["sources"].values():
        agg["avg_score"] = round(agg["avg_score"] / max(1, agg["count"]), 1)
    return summary


def run_self_improvement(db: Session, bot: Bot) -> dict[str, Any]:
    """Aggregate performance, ask the local model for insights, persist them."""
    summary = aggregate_performance(db, bot)
    import json

    prompt = bot_prompts.SELF_IMPROVEMENT_USER_TEMPLATE.format(
        bot_name=bot.name,
        bot_type=bot.bot_type,
        summary=json.dumps(summary, indent=2)[:6000],
    )
    try:
        insights, meta = ollama_service.generate_json(
            "reasoning",
            prompt,
            assignments=bot.model_assignments,
            system=bot_prompts.SELF_IMPROVEMENT_SYSTEM,
            schema=bot_prompts.SELF_IMPROVEMENT_SCHEMA,
            options={"temperature": 0.4},
        )
    except Exception as exc:
        logger.warning("Self-improvement analysis failed for bot %s: %s", bot.id, exc)
        return bot.insights or {}

    insights["_summary"] = summary
    insights["_generated_at"] = datetime.now(timezone.utc).isoformat()
    insights["_model"] = meta.get("model")
    bot.insights = insights
    return insights
