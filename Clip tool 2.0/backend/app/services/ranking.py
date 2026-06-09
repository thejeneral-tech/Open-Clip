"""AI clip ranking / scoring."""
from __future__ import annotations

from typing import Any

from app.core.config import settings
from app.core.logging import get_logger
from app.services import prompts
from app.services.ollama_client import OllamaClient, ollama

logger = get_logger(__name__)

# Weights used to synthesize an overall score if the model omits one.
_WEIGHTS = {
    "hook_strength": 0.30,
    "emotional_intensity": 0.20,
    "curiosity_gap": 0.20,
    "retention_likelihood": 0.20,
    "platform_suitability": 0.10,
}


def _clamp(v: Any, default: float = 50.0) -> float:
    try:
        return max(0.0, min(100.0, float(v)))
    except (TypeError, ValueError):
        return default


def rank_clip(
    *,
    title: str,
    text: str,
    duration: float,
    model: str | None = None,
    client: OllamaClient | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Score a single clip.

    Returns ``(result, meta)``. ``result`` keys:
      hook_strength, emotional_intensity, curiosity_gap, retention_likelihood,
      platform_suitability, overall_score, confidence, explanation
    """
    client = client or ollama
    user_prompt = prompts.RANKING_USER_TEMPLATE.format(
        title=title or "Untitled", duration=duration, text=text or "(no transcript)"
    )
    parsed, meta = client.generate_json(
        user_prompt,
        model=model or settings.OLLAMA_RANKING_MODEL,
        system=prompts.RANKING_SYSTEM,
        schema=prompts.RANKING_SCHEMA,
        options={"temperature": 0.3},
    )
    if not isinstance(parsed, dict):
        parsed = {}

    breakdown = {k: _clamp(parsed.get(k)) for k in _WEIGHTS}

    overall = parsed.get("overall_score")
    if overall is None:
        overall = sum(breakdown[k] * w for k, w in _WEIGHTS.items())
    overall = _clamp(overall)

    result = {
        **breakdown,
        "overall_score": round(overall, 1),
        "confidence": _clamp(parsed.get("confidence"), 60.0),
        "explanation": str(parsed.get("explanation") or "").strip(),
    }
    return result, meta
