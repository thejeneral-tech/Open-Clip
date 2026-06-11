"""Consolidated per-clip metadata generation.

A single LLM call that returns ranking + titles + description + b-roll, instead
of four separate round-trips. On a local CPU/iGPU model this is a meaningful
speedup: the transcript is fed (prompt-evaluated) once rather than four times,
and reasoning models emit one chain of thought rather than four.

The individual services (``ranking``/``titles``/``descriptions``/``broll``) are
left intact — they're still used by ``regenerate_clip_task`` to refresh one
field at a time at full quality. This module reuses their ``normalize_*``
helpers so the parsed shapes stay identical.
"""
from __future__ import annotations

from typing import Any

from app.core.logging import get_logger
from app.services import broll, descriptions, prompts, ranking, titles
from app.services.ollama_client import OllamaClient, ollama

logger = get_logger(__name__)


def generate_clip_metadata(
    *,
    title: str,
    text: str,
    duration: float,
    model: str | None = None,
    client: OllamaClient | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Produce ranking + titles + description + b-roll in one call.

    Returns ``(result, meta)`` where ``result`` has keys ``ranking`` (dict),
    ``titles`` (dict), ``description`` (dict), and ``broll`` (list) — each in the
    same shape the standalone services return.
    """
    client = client or ollama
    user_prompt = prompts.CLIP_META_USER_TEMPLATE.format(
        title=title or "Untitled", duration=duration, text=text or "(no transcript)"
    )
    parsed, meta = client.generate_json(
        user_prompt,
        model=model,
        system=prompts.CLIP_META_SYSTEM,
        schema=prompts.CLIP_META_SCHEMA,
        options={"temperature": 0.6},
    )
    if not isinstance(parsed, dict):
        parsed = {}

    broll_raw = parsed.get("broll") or {}
    suggestions = broll_raw.get("suggestions") if isinstance(broll_raw, dict) else broll_raw

    result = {
        "ranking": ranking.normalize_ranking(parsed.get("ranking")),
        "titles": titles.normalize_titles(parsed.get("titles")),
        "description": descriptions.normalize_description(parsed.get("description")),
        "broll": broll.normalize_broll(suggestions),
    }
    return result, meta
