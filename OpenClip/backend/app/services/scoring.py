"""Local trend scoring + content filtering.

Produces a 0–100 trend score from engagement velocities, recency, and (optionally)
an Ollama-judged topic-relevance signal — all computed locally. The weights are
configurable per preset/bot (``scoring_config.weights``).
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

from app.core.logging import get_logger
from app.services.discovery.base import DiscoveredItem
from app.services.ollama_service import ollama_service

logger = get_logger(__name__)

# Saturation pivots: a per-hour velocity equal to the pivot scores 50/100.
_PIVOTS = {
    "view_velocity": 500.0,
    "like_velocity": 50.0,
    "comment_velocity": 10.0,
    "share_velocity": 5.0,
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _age_hours(published_at: datetime | None) -> float:
    if not published_at:
        return 24.0
    if published_at.tzinfo is None:
        published_at = published_at.replace(tzinfo=timezone.utc)
    delta = (_now() - published_at).total_seconds() / 3600.0
    return max(0.5, delta)


def _saturate(value: float, pivot: float) -> float:
    """Map a non-negative value to 0–100, hitting 50 at ``value == pivot``."""
    if value <= 0:
        return 0.0
    return 100.0 * value / (value + pivot)


def _velocities(metrics: dict[str, Any], age_hours: float) -> dict[str, float]:
    def per_hour(key: str) -> float:
        try:
            return float(metrics.get(key, 0) or 0) / age_hours
        except (TypeError, ValueError):
            return 0.0

    return {
        "view_velocity": _saturate(per_hour("views"), _PIVOTS["view_velocity"]),
        "like_velocity": _saturate(per_hour("likes"), _PIVOTS["like_velocity"]),
        "comment_velocity": _saturate(per_hour("comments"), _PIVOTS["comment_velocity"]),
        "share_velocity": _saturate(per_hour("shares"), _PIVOTS["share_velocity"]),
    }


def _recency_score(age_hours: float, max_age_hours: float) -> float:
    if max_age_hours <= 0:
        return 50.0
    # Exponential decay with a half-life of a quarter of the window.
    half_life = max(1.0, max_age_hours / 4.0)
    return max(0.0, min(100.0, 100.0 * math.exp(-math.log(2) * age_hours / half_life)))


def passes_filters(item: DiscoveredItem, filters: dict[str, Any]) -> tuple[bool, str]:
    """Apply a bot's content filters. Returns ``(ok, reason_if_rejected)``."""
    text = f"{item.title or ''} {item.description or ''}".lower()

    neg = [k.lower() for k in filters.get("negative_keywords", []) if k]
    hit = next((k for k in neg if k in text), None)
    if hit:
        return False, f"negative keyword: {hit}"

    keywords = [k.lower() for k in filters.get("keywords", []) if k]
    if keywords and not any(k in text for k in keywords):
        return False, "no required keyword matched"

    langs = filters.get("languages") or []
    if langs and item.language and item.language.split("-")[0] not in langs:
        return False, f"language {item.language} not in {langs}"

    dur = item.duration_seconds
    if dur is not None:
        if dur < filters.get("min_duration", 0):
            return False, f"too short ({dur:.0f}s)"
        if filters.get("max_duration") and dur > filters["max_duration"]:
            return False, f"too long ({dur:.0f}s)"

    views = float(item.metrics.get("views", 0) or 0)
    if views and views < filters.get("min_views", 0):
        return False, f"below min_views ({views:.0f})"

    age = _age_hours(item.published_at)
    if filters.get("max_age_hours") and age > filters["max_age_hours"]:
        return False, f"too old ({age:.0f}h)"

    return True, ""


def llm_relevance(
    item: DiscoveredItem, *, topic: str, keywords: list[str], assignments: dict[str, Any] | None
) -> float:
    """Ask the local model how on-topic an item is (0–100). Best-effort."""
    from app.services import bot_prompts

    prompt = bot_prompts.RELEVANCE_USER_TEMPLATE.format(
        topic=topic or "(general short-form virality)",
        keywords=", ".join(keywords) or "(none)",
        title=item.title or "",
        description=(item.description or "")[:600],
    )
    try:
        parsed, _ = ollama_service.generate_json(
            "scoring",
            prompt,
            assignments=assignments,
            system=bot_prompts.RELEVANCE_SYSTEM,
            schema=bot_prompts.RELEVANCE_SCHEMA,
            options={"temperature": 0.2},
        )
        return max(0.0, min(100.0, float(parsed.get("relevance", 50))))
    except Exception as exc:
        logger.debug("LLM relevance unavailable, defaulting to neutral: %s", exc)
        return 50.0


def score_item(
    item: DiscoveredItem,
    *,
    scoring_config: dict[str, Any],
    relevance: float | None = None,
    historical: float = 50.0,
) -> tuple[float, dict[str, Any]]:
    """Compute the 0–100 trend score and a component breakdown."""
    weights: dict[str, float] = dict(scoring_config.get("weights", {}))
    age_hours = _age_hours(item.published_at)
    components = _velocities(item.metrics, age_hours)
    components["trend_velocity"] = (
        components["view_velocity"] * 0.6 + components["like_velocity"] * 0.4
    )
    components["recency"] = _recency_score(age_hours, scoring_config.get("max_age_hours", 720))
    components["relevance"] = 50.0 if relevance is None else float(relevance)
    components["historical"] = float(historical)

    total_w = sum(max(0.0, w) for w in weights.values()) or 1.0
    score = sum(components.get(k, 0.0) * max(0.0, w) for k, w in weights.items()) / total_w
    score = round(max(0.0, min(100.0, score)), 2)

    breakdown = {k: round(v, 2) for k, v in components.items()}
    breakdown["weights"] = weights
    breakdown["age_hours"] = round(age_hours, 2)
    return score, breakdown
