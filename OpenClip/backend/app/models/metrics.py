"""BotMetric model — a time-series performance record feeding the learning loop."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base
from app.models.mixins import CreatedAtMixin


class BotMetric(CreatedAtMixin, Base):
    __tablename__ = "bot_metrics"

    id: Mapped[int] = mapped_column(primary_key=True)
    bot_id: Mapped[int] = mapped_column(
        ForeignKey("bots.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # What the metric refers to (e.g. "clip") and the id of that thing.
    scope: Mapped[str] = mapped_column(String(32), nullable=False)
    ref_id: Mapped[int | None] = mapped_column(Integer, default=None)
    platform: Mapped[str | None] = mapped_column(String(32), default=None)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
