"""Reddit story discovery via the public ``.json`` listing endpoints.

No OAuth required — a descriptive User-Agent and modest limits keep us inside
Reddit's unauthenticated rate allowances.
"""
from __future__ import annotations

import html
import re
from typing import Any

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

_UA = "OpenClip-StoryVault/1.0 (local video studio)"
_VALID_SORTS = {"hot", "top", "new", "rising"}
_VALID_WINDOWS = {"hour", "day", "week", "month", "year", "all"}

# Markdown / formatting noise we strip before scoring and narration.
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_MD_MARKS = re.compile(r"[*_~^]{1,3}")
_WS = re.compile(r"[ \t]+")


def clean_text(raw: str) -> str:
    text = html.unescape(raw or "")
    text = _MD_LINK.sub(r"\1", text)
    text = text.replace("&#x200B;", " ").replace("​", " ")
    text = _MD_MARKS.sub("", text)
    lines = [_WS.sub(" ", ln).strip() for ln in text.splitlines()]
    out: list[str] = []
    blank = False
    for ln in lines:
        if not ln:
            if not blank:
                out.append("")
            blank = True
        else:
            out.append(ln)
            blank = False
    return "\n".join(out).strip()


async def fetch_community(
    community: str,
    *,
    sort: str = "top",
    time_window: str = "week",
    limit: int = 25,
    min_upvotes: int = 0,
    min_length: int = 300,
) -> list[dict[str, Any]]:
    """Fetch text posts from a subreddit; returns normalized story dicts."""
    sub = community.strip().lstrip("r/").strip("/")
    if not sub:
        return []
    sort = sort if sort in _VALID_SORTS else "top"
    time_window = time_window if time_window in _VALID_WINDOWS else "week"
    limit = max(1, min(100, limit))

    url = f"https://www.reddit.com/r/{sub}/{sort}.json"
    params = {"limit": str(limit), "raw_json": "1"}
    if sort == "top":
        params["t"] = time_window

    async with httpx.AsyncClient(
        headers={"User-Agent": _UA}, timeout=30, follow_redirects=True
    ) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()

    stories: list[dict[str, Any]] = []
    for child in data.get("data", {}).get("children", []):
        post = child.get("data", {})
        if post.get("stickied") or post.get("over_18"):
            continue
        body = clean_text(post.get("selftext") or "")
        if len(body) < min_length:
            continue
        ups = int(post.get("ups") or 0)
        if ups < min_upvotes:
            continue
        stories.append(
            {
                "source": "reddit",
                "external_id": f"reddit:{post.get('id')}",
                "source_url": f"https://www.reddit.com{post.get('permalink', '')}",
                "community": f"r/{post.get('subreddit', sub)}",
                "author": post.get("author"),
                "title": clean_text(post.get("title") or "")[:512],
                "body": body,
                "upvotes": ups,
                "num_comments": int(post.get("num_comments") or 0),
            }
        )
    logger.info("Reddit r/%s (%s): %d usable stories", sub, sort, len(stories))
    return stories
