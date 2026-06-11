"""Auto title generation (20 variations across platforms)."""
from __future__ import annotations

from typing import Any

from app.core.logging import get_logger
from app.services import prompts
from app.services.ollama_client import OllamaClient, ollama

logger = get_logger(__name__)


def normalize_titles(parsed: Any) -> dict[str, Any]:
    """Coerce a raw model ``titles`` object into ``{tiktok, shorts, reels, best, all}``.

    Shared by :func:`generate_titles` and the consolidated ``clip_meta`` call.
    """
    if not isinstance(parsed, dict):
        parsed = {}
    tiktok = [str(t) for t in parsed.get("tiktok", []) if t]
    shorts = [str(t) for t in parsed.get("shorts", []) if t]
    reels = [str(t) for t in parsed.get("reels", []) if t]
    all_titles = tiktok + shorts + reels
    best = str(parsed.get("best") or (all_titles[0] if all_titles else "Untitled"))
    return {"tiktok": tiktok, "shorts": shorts, "reels": reels, "best": best, "all": all_titles}


def generate_titles(
    *,
    text: str,
    model: str | None = None,
    client: OllamaClient | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return ``({tiktok, shorts, reels, best, all}, meta)``."""
    client = client or ollama
    user_prompt = prompts.TITLES_USER_TEMPLATE.format(text=text or "(no transcript)")
    parsed, meta = client.generate_json(
        user_prompt,
        model=model,
        system=prompts.TITLES_SYSTEM,
        schema=prompts.TITLES_SCHEMA,
        options={"temperature": 0.9},
    )
    return normalize_titles(parsed), meta
