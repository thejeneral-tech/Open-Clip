"""Publishing models: a platform connector (credentials) and a publish job."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base
from app.models.enums import ConnectorStatus, PublishStatus
from app.models.mixins import CreatedAtMixin


class PublishingConnector(CreatedAtMixin, Base):
    __tablename__ = "publishing_connectors"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # A connector may be scoped to a single bot, or shared (NULL bot_id).
    bot_id: Mapped[int | None] = mapped_column(
        ForeignKey("bots.id", ondelete="SET NULL"), index=True, default=None
    )

    platform: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), default=ConnectorStatus.DISCONNECTED.value, nullable=False
    )
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    # Secrets — never serialized back out to the API.
    credentials: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    last_error: Mapped[str | None] = mapped_column(Text, default=None)


class PublishingJob(CreatedAtMixin, Base):
    __tablename__ = "publishing_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    bot_id: Mapped[int | None] = mapped_column(
        ForeignKey("bots.id", ondelete="CASCADE"), index=True, default=None
    )
    clip_id: Mapped[int] = mapped_column(
        ForeignKey("clips.id", ondelete="CASCADE"), index=True, nullable=False
    )
    connector_id: Mapped[int | None] = mapped_column(
        ForeignKey("publishing_connectors.id", ondelete="SET NULL"), index=True, default=None
    )

    platform: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), default=PublishStatus.PENDING.value, nullable=False
    )
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)

    title: Mapped[str | None] = mapped_column(Text, default=None)
    description: Mapped[str | None] = mapped_column(Text, default=None)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    external_post_id: Mapped[str | None] = mapped_column(String(255), default=None)
    external_url: Mapped[str | None] = mapped_column(Text, default=None)
    analytics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    retries: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, default=None)
