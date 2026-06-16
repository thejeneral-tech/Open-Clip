"""Discovery plugin contract."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.models.trend import TrendSource


@dataclass
class DiscoveredItem:
    """One piece of content found by a plugin (pre-scoring, pre-ingest)."""

    platform: str
    external_id: str
    url: str
    title: str | None = None
    author: str | None = None
    description: str | None = None
    thumbnail_url: str | None = None
    language: str | None = None
    duration_seconds: float | None = None
    published_at: datetime | None = None
    # Raw engagement: {views, likes, comments, shares, ...}.
    metrics: dict[str, Any] = field(default_factory=dict)

    def to_row(self) -> dict[str, Any]:
        return {
            "platform": self.platform,
            "external_id": self.external_id,
            "url": self.url,
            "title": self.title,
            "author": self.author,
            "description": self.description,
            "thumbnail_url": self.thumbnail_url,
            "language": self.language,
            "duration_seconds": self.duration_seconds,
            "published_at": self.published_at,
            "metrics": self.metrics,
        }


class DiscoveryPlugin(ABC):
    """Base class for a platform discovery plugin."""

    #: platform key this plugin handles (matches SourcePlatform values).
    platform: str = ""

    @abstractmethod
    def discover(
        self, source: TrendSource, *, limit: int = 25, lookback_hours: int = 168
    ) -> list[DiscoveredItem]:
        """Return up to ``limit`` items for ``source`` within the lookback window."""
        raise NotImplementedError
