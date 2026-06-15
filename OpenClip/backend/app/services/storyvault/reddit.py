"""Reddit story discovery via the public ``.rss`` listing feeds.

Reddit now hard-blocks its unauthenticated ``.json`` listing endpoints (they
return HTTP 403 with an anti-bot HTML page regardless of User-Agent), but the
equivalent ``.rss`` Atom feeds remain open. We read those instead and parse the
entries. Trade-off: RSS does not expose score/comment counts, so ``upvotes`` and
``num_comments`` come back as 0 and ``min_upvotes`` filtering is a no-op.
"""
from __future__ import annotations

import asyncio
import html
import re
import xml.etree.ElementTree as ET
from typing import Any

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

# Reddit throttles rapid unauthenticated reads with HTTP 429 — empirically only
# ~one feed fetch per ~30-40s per IP, with no Retry-After header and a cooldown
# far too long to wait out inside a request. So we retry only briefly to ride out
# a genuine transient blip, then fail fast and let the caller surface a clear
# "rate-limited, try one subreddit at a time" message (see discovery_search).
_MAX_ATTEMPTS = 2
_MAX_BACKOFF = 5.0

# Present as a real browser; bare library User-Agents are more likely to be
# challenged by Reddit's edge.
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_HEADERS = {
    "User-Agent": _UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
_VALID_SORTS = {"hot", "top", "new", "rising"}
_VALID_WINDOWS = {"hour", "day", "week", "month", "year", "all"}

_ATOM = "{http://www.w3.org/2005/Atom}"

# Markdown / formatting noise we strip before scoring and narration.
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_MD_MARKS = re.compile(r"[*_~^]{1,3}")
_WS = re.compile(r"[ \t]+")

# RSS entry bodies are rendered HTML; turn block-level tags into line breaks
# before stripping the rest so paragraphs survive.
_HTML_BR = re.compile(r"<br\s*/?>", re.I)
_HTML_BLOCK = re.compile(r"</(p|div|li|ul|ol|blockquote|h[1-6]|tr|table)>", re.I)
_HTML_TAG = re.compile(r"<[^>]+>")


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


def _html_to_text(raw: str) -> str:
    """Flatten a Reddit RSS HTML body to clean plain text."""
    text = _HTML_BR.sub("\n", raw or "")
    text = _HTML_BLOCK.sub("\n", text)
    text = _HTML_TAG.sub("", text)
    return clean_text(text)


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
    sub = community.strip().removeprefix("/").removeprefix("r/").strip("/")
    if not sub:
        return []
    sort = sort if sort in _VALID_SORTS else "top"
    time_window = time_window if time_window in _VALID_WINDOWS else "week"
    limit = max(1, min(100, limit))

    params = {"limit": str(limit)}
    if sort == "top":
        params["t"] = time_window
    url = f"https://www.reddit.com/r/{sub}/{sort}.rss"

    async with httpx.AsyncClient(
        headers=_HEADERS, timeout=30, follow_redirects=True
    ) as client:
        for attempt in range(_MAX_ATTEMPTS):
            resp = await client.get(url, params=params)
            if resp.status_code == 429 and attempt < _MAX_ATTEMPTS - 1:
                # Honour Retry-After when present, else a short fixed backoff.
                hinted = float(resp.headers.get("retry-after") or 0)
                wait = min(hinted or _MAX_BACKOFF, _MAX_BACKOFF)
                logger.info("Reddit r/%s rate-limited (429); one quick retry in %.0fs", sub, wait)
                await asyncio.sleep(wait)
                continue
            break
        resp.raise_for_status()
        feed = resp.text

    try:
        root = ET.fromstring(feed)
    except ET.ParseError:
        logger.warning("Reddit r/%s (%s): unparseable RSS feed", sub, sort)
        return []

    stories: list[dict[str, Any]] = []
    for entry in root.findall(f"{_ATOM}entry"):
        body = _html_to_text(entry.findtext(f"{_ATOM}content") or "")
        if len(body) < min_length:
            continue

        # Atom id looks like "t3_abc123"; the trailing token is the post id.
        post_id = (entry.findtext(f"{_ATOM}id") or "").split("_")[-1]
        author = (entry.findtext(f"{_ATOM}author/{_ATOM}name") or "").removeprefix("/u/")
        link = entry.find(f"{_ATOM}link")
        source_url = link.get("href") if link is not None else ""
        stories.append(
            {
                "source": "reddit",
                "external_id": f"reddit:{post_id}",
                "source_url": source_url,
                "community": f"r/{sub}",
                "author": author or None,
                "title": clean_text(entry.findtext(f"{_ATOM}title") or "")[:512],
                "body": body,
                # RSS feeds omit these counts; they default to 0 and engagement
                # scoring falls back to its baseline.
                "upvotes": 0,
                "num_comments": 0,
            }
        )
    if min_upvotes > 0:
        logger.debug("Reddit r/%s: min_upvotes ignored (RSS has no score)", sub)
    logger.info("Reddit r/%s (%s): %d usable stories", sub, sort, len(stories))
    return stories
