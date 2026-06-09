"""Auto descriptions: SEO copy, hashtags, keywords."""
from __future__ import annotations

from typing import Any

from app.core.logging import get_logger
from app.services import prompts
from app.services.ollama_client import OllamaClient, ollama

logger = get_logger(__name__)


def _norm_tags(tags: Any) -> list[str]:
    out: list[str] = []
    for t in tags or []:
        t = str(t).strip()
        if not t:
            continue
        if not t.startswith("#"):
            t = "#" + t.lstrip("#").replace(" ", "")
        out.append(t)
    return out


def normalize_description(parsed: Any) -> dict[str, Any]:
    """Coerce a raw model ``description`` object into ``{description, hashtags, keywords}``.

    Shared by :func:`generate_description` and the consolidated ``clip_meta`` call.
    """
    if not isinstance(parsed, dict):
        parsed = {}
    return {
        "description": str(parsed.get("description") or "").strip(),
        "hashtags": _norm_tags(parsed.get("hashtags")),
        "keywords": [str(k).strip() for k in parsed.get("keywords", []) if str(k).strip()],
    }


def generate_description(
    *,
    title: str,
    text: str,
    model: str | None = None,
    client: OllamaClient | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    client = client or ollama
    user_prompt = prompts.DESCRIPTION_USER_TEMPLATE.format(
        title=title or "Untitled", text=text or "(no transcript)"
    )
    parsed, meta = client.generate_json(
        user_prompt,
        model=model,
        system=prompts.DESCRIPTION_SYSTEM,
        schema=prompts.DESCRIPTION_SCHEMA,
        options={"temperature": 0.7},
    )
    return normalize_description(parsed), meta
