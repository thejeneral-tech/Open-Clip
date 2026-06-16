"""YouTube discovery via yt-dlp (no API key required).

``source.identifier`` may be:
  * a full URL (channel/playlist/video) — used as-is,
  * an ``@handle`` — expanded to that channel's uploads,
  * any other text — treated as a search query (``ytsearchN:``).

Listing uses flat extraction (fast, one request) so we get titles, ids,
durations and — when YouTube exposes them — view counts, without downloading.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from app.core.logging import get_logger
from app.services.discovery.base import DiscoveredItem
from app.services.discovery.registry import register

if TYPE_CHECKING:
    from app.models.trend import TrendSource

logger = get_logger(__name__)


def _resolve_target(identifier: str, limit: int) -> str:
    ident = identifier.strip()
    if ident.startswith("http://") or ident.startswith("https://"):
        return ident
    if ident.startswith("@"):
        return f"https://www.youtube.com/{ident}/videos"
    return f"ytsearch{limit}:{ident}"


def _parse_upload_date(raw: Any) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.strptime(str(raw), "%Y%m%d").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


class YouTubePlugin:
    platform = "youtube"

    def discover(
        self, source: TrendSource, *, limit: int = 25, lookback_hours: int = 168
    ) -> list[DiscoveredItem]:
        import yt_dlp

        target = _resolve_target(source.identifier, limit)
        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extract_flat": "in_playlist",
            "playlistend": limit,
            "noprogress": True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(target, download=False)

        entries = info.get("entries") or ([info] if info.get("id") else [])
        out: list[DiscoveredItem] = []
        for e in entries:
            if not e:
                continue
            vid = e.get("id")
            if not vid:
                continue
            url = e.get("url") or e.get("webpage_url") or f"https://www.youtube.com/watch?v={vid}"
            if url.startswith("/") or not url.startswith("http"):
                url = f"https://www.youtube.com/watch?v={vid}"
            metrics: dict[str, Any] = {}
            if e.get("view_count") is not None:
                metrics["views"] = int(e["view_count"])
            if e.get("like_count") is not None:
                metrics["likes"] = int(e["like_count"])
            if e.get("comment_count") is not None:
                metrics["comments"] = int(e["comment_count"])
            out.append(
                DiscoveredItem(
                    platform=source.platform,
                    external_id=vid,
                    url=url,
                    title=e.get("title"),
                    author=e.get("uploader") or e.get("channel"),
                    description=e.get("description"),
                    thumbnail_url=(e.get("thumbnails") or [{}])[-1].get("url")
                    if e.get("thumbnails")
                    else e.get("thumbnail"),
                    duration_seconds=float(e["duration"]) if e.get("duration") else None,
                    published_at=_parse_upload_date(e.get("upload_date")),
                    metrics=metrics,
                )
            )
        return out[:limit]


register(YouTubePlugin())
