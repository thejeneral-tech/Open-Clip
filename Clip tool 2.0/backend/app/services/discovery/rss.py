"""RSS / Atom discovery using only the standard-library XML parser.

Handles both RSS 2.0 (``channel/item``) and Atom (``feed/entry``), plus the
YouTube channel feed flavour (``media:*`` / ``yt:videoId``). No third-party feed
library is required, so this works in a stock install.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import TYPE_CHECKING

import httpx

from app.core.config import settings
from app.core.logging import get_logger
from app.services.discovery.base import DiscoveredItem
from app.services.discovery.registry import register

if TYPE_CHECKING:
    from app.models.trend import TrendSource

logger = get_logger(__name__)

_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "media": "http://search.yahoo.com/mrss/",
    "yt": "http://www.youtube.com/xml/schemas/2015",
}


def _parse_date(text: str | None) -> datetime | None:
    if not text:
        return None
    text = text.strip()
    # RFC-822 (RSS pubDate).
    try:
        dt = parsedate_to_datetime(text)
        if dt:
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        pass
    # ISO-8601 (Atom).
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _text(el: ET.Element | None) -> str | None:
    return el.text.strip() if el is not None and el.text else None


class RssPlugin:
    platform = "rss"

    def discover(
        self, source: "TrendSource", *, limit: int = 25, lookback_hours: int = 168
    ) -> list[DiscoveredItem]:
        headers = {"User-Agent": settings.DISCOVERY_USER_AGENT}
        with httpx.Client(timeout=30, headers=headers, follow_redirects=True) as client:
            resp = client.get(source.identifier)
            resp.raise_for_status()
            root = ET.fromstring(resp.content)

        items: list[DiscoveredItem] = []
        # RSS 2.0
        for item in root.findall(".//item"):
            link = _text(item.find("link"))
            guid = _text(item.find("guid")) or link
            if not link:
                continue
            yt_id = _text(item.find("yt:videoId", _NS))
            media = item.find("media:group", _NS)
            thumb = None
            if media is not None:
                mt = media.find("media:thumbnail", _NS)
                if mt is not None:
                    thumb = mt.get("url")
            items.append(
                DiscoveredItem(
                    platform=source.platform,
                    external_id=yt_id or guid or link,
                    url=link,
                    title=_text(item.find("title")),
                    author=_text(item.find("{http://purl.org/dc/elements/1.1/}creator")),
                    description=_text(item.find("description")),
                    thumbnail_url=thumb,
                    published_at=_parse_date(_text(item.find("pubDate"))),
                )
            )
        # Atom
        for entry in root.findall("atom:entry", _NS) or root.findall(".//{*}entry"):
            link_el = entry.find("atom:link", _NS)
            link = link_el.get("href") if link_el is not None else None
            yt_id = _text(entry.find("yt:videoId", _NS))
            eid = _text(entry.find("atom:id", _NS)) or yt_id or link
            if not (link or yt_id):
                continue
            media = entry.find("media:group", _NS)
            thumb = desc = None
            views = None
            if media is not None:
                mt = media.find("media:thumbnail", _NS)
                if mt is not None:
                    thumb = mt.get("url")
                desc = _text(media.find("media:description", _NS))
                stats = media.find("media:community/media:statistics", _NS)
                if stats is not None and stats.get("views"):
                    views = int(stats.get("views"))
            url = link or (f"https://www.youtube.com/watch?v={yt_id}" if yt_id else "")
            author_el = entry.find("atom:author/atom:name", _NS)
            items.append(
                DiscoveredItem(
                    platform=source.platform,
                    external_id=yt_id or eid or url,
                    url=url,
                    title=_text(entry.find("atom:title", _NS)),
                    author=_text(author_el),
                    description=desc or _text(entry.find("atom:summary", _NS)),
                    thumbnail_url=thumb,
                    published_at=_parse_date(_text(entry.find("atom:published", _NS))),
                    metrics={"views": views} if views is not None else {},
                )
            )
        return items[:limit]


register(RssPlugin())
