"""B-roll suggestions (and optional Stable Diffusion generation hooks)."""
from __future__ import annotations

from typing import Any

from app.core.logging import get_logger
from app.services import prompts
from app.services.ollama_client import OllamaClient, ollama

logger = get_logger(__name__)


def suggest_broll(
    *,
    text: str,
    model: str | None = None,
    client: OllamaClient | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    client = client or ollama
    user_prompt = prompts.BROLL_USER_TEMPLATE.format(text=text or "(no transcript)")
    parsed, meta = client.generate_json(
        user_prompt,
        model=model,
        system=prompts.BROLL_SYSTEM,
        schema=prompts.BROLL_SCHEMA,
        options={"temperature": 0.7},
    )
    suggestions = parsed.get("suggestions", []) if isinstance(parsed, dict) else []

    out: list[dict[str, Any]] = []
    for s in suggestions:
        if not isinstance(s, dict):
            continue
        out.append(
            {
                "start": float(s.get("start", 0) or 0),
                "end": float(s.get("end", 0) or 0),
                "search_terms": [str(t) for t in s.get("search_terms", []) if t],
                "scene_description": str(s.get("scene_description") or ""),
                "sd_prompt": str(s.get("sd_prompt") or ""),
            }
        )
    return out, meta


def generate_broll_image(prompt: str, output_path: str) -> str | None:
    """Optional: generate a still via a Stable Diffusion endpoint (AUTOMATIC1111
    / ComfyUI compatible). Returns the path on success, ``None`` if unconfigured.

    This is intentionally a pluggable stub — wiring a specific SD backend is a
    deployment choice. See ``docs`` for enabling it.
    """
    logger.info("SD generation requested but no backend configured: %s", prompt[:80])
    return None
