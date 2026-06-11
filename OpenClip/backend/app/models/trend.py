"""Trend discovery models: a polled source and a discovered candidate item."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.core.database import Base
from app.models.enums import SourceListMode, SourcePlatform, TrendItemStatus
from app.models.mixins import CreatedAtMixin


class TrendSource(CreatedAtMixin, Base):
    __tablename__ = "trend_sources"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, default=None
    )
    bot_id: Mapped[int | None] = mapped_column(
        ForeignKey("bots.id", ondelete="CASCADE"), index=True, default=None
    )

    platform: Mapped[str] = mapped_column(
        String(32), default=SourcePlatform.RSS.value, nullable=False
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    identifier: Mapped[str] = mapped_column(Text, nullable=False)
    list_mode: Mapped[str] = mapped_column(
        String(16), default=SourceListMode.ALLOW.value, nullable=False
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_error: Mapped[str | None] = mapped_column(Text, default=None)


class TrendItem(CreatedAtMixin, Base):
    __tablename__ = "trend_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    bot_id: Mapped[int] = mapped_column(
        ForeignKey("bots.id", ondelete="CASCADE"), index=True, nullable=False
    )
    source_id: Mapped[int | None] = mapped_column(
        ForeignKey("trend_sources.id", ondelete="SET NULL"), index=True, default=None
    )
    video_id: Mapped[int | None] = mapped_column(
        ForeignKey("videos.id", ondelete="SET NULL"), index=True, default=None
    )

    platform: Mapped[str] = mapped_column(String(32), nullable=False)
    external_id: Mapped[str] = mapped_column(String(255), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text, default=None)
    author: Mapped[str | None] = mapped_column(String(255), default=None)
    description: Mapped[str | None] = mapped_column(Text, default=None)
    thumbnail_url: Mapped[str | None] = mapped_column(Text, default=None)
    language: Mapped[str | None] = mapped_column(String(16), default=None)
    duration_seconds: Mapped[float | None] = mapped_column(Float, default=None)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)

    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    score_breakdown: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    trend_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), default=TrendItemStatus.DISCOVERED.value, nullable=False
    )
    reason: Mapped[str | None] = mapped_column(Text, default=None)

    source: Mapped["TrendSource | None"] = relationship("TrendSource")
