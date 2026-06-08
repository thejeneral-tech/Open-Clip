"""Reddit discovery via the public JSON API (no auth, just a User-Agent).

``source.identifier`` may be a subreddit name (``videos``), a multi (``r/a+b``),
or a full listing URL. We surface posts that link to external video content
(YouTube etc.) which the normal yt-dlp ingestion can then download.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

import httpx

from app.core.config import settings
from app.core.logging import get_logger
from app.services.discovery.base import DiscoveredItem
from app.services.discovery.registry import register

if TYPE_CHECKING:
    from app.models.trend import TrendSource

logger = get_logger(__name__)

_VIDEO_DOMAINS = ("youtube.com", "youtu.be", "v.redd.it", "vimeo.com", "twitch.tv")


def _listing_url(identifier: str, limit: int) -> str:
    ident = identifier.strip()
    if ident.startswith("http"):
        base = ident.split("?")[0].rstrip("/")
        if not base.endswith(".json"):
            base += ".json"
        return f"{base}?limit={limit}"
    ident = ident.removeprefix("r/").strip("/")
    sort = "hot"
    return f"https://www.reddit.com/r/{ident}/{sort}.json?limit={limit}"


class RedditPlugin:
    platform = "reddit"

    def discover(
        self, source: "TrendSource", *, limit: int = 25, lookback_hours: int = 168
    ) -> list[DiscoveredItem]:
        url = _listing_url(source.identifier, limit)
        headers = {"User-Agent": settings.DISCOVERY_USER_AGENT}
        with httpx.Client(timeout=30, headers=headers, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.json()

        out: list[DiscoveredItem] = []
        for child in data.get("data", {}).get("children", []):
            post: dict[str, Any] = child.get("data", {})
            outbound = post.get("url_overridden_by_dest") or post.get("url") or ""
            is_video = post.get("is_video") or any(d in outbound for d in _VIDEO_DOMAINS)
            if not is_video or not outbound:
                continue
            created = post.get("created_utc")
            published = (
                datetime.fromtimestamp(created, tz=timezone.utc) if created else None
            )
            out.append(
                DiscoveredItem(
                    platform=source.platform,
                    external_id=post.get("id") or outbound,
                    url=outbound,
                    title=post.get("title"),
                    author=post.get("author"),
                    description=post.get("selftext") or None,
                    thumbnail_url=(post.get("thumbnail") if str(post.get("thumbnail", "")).startswith("http") else None),
                    published_at=published,
                    metrics={
                        "likes": int(post.get("ups", 0) or 0),
                        "comments": int(post.get("num_comments", 0) or 0),
                        "upvote_ratio": post.get("upvote_ratio"),
                    },
                )
            )
        return out[:limit]


register(RedditPlugin())
