"""Bot automation models: the bot itself, its run history, and reusable presets.

A :class:`Bot` snapshots its preset's resolved config onto its own JSON columns
(``discovery_config`` … ``publishing_config``) so editing a preset never silently
mutates a running bot. :class:`BotRun` records one cycle; :class:`BotPreset` is a
versioned, listable bundle (system rows have ``owner_id IS NULL``).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base
from app.models.enums import ApprovalMode, BotRunTrigger, BotStatus
from app.models.mixins import CreatedAtMixin, TimestampMixin


class Bot(TimestampMixin, Base):
    __tablename__ = "bots"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # Each bot writes into a dedicated project (lazily created on first run).
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), index=True, default=None
    )

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, default=None)
    bot_type: Mapped[str] = mapped_column(String(64), default="custom", nullable=False)
    preset_key: Mapped[str] = mapped_column(String(64), default="CUSTOM", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default=BotStatus.STOPPED.value, nullable=False)
    approval_mode: Mapped[str] = mapped_column(
        String(32), default=ApprovalMode.MANUAL.value, nullable=False
    )

    # Snapshotted config sections + per-stage model overrides.
    model_assignments: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    discovery_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    filter_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    scoring_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    clipping_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    publishing_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    schedule_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    # Lifetime counters + the self-improvement loop's recommendations.
    stats: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    insights: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_error: Mapped[str | None] = mapped_column(Text, default=None)


class BotRun(CreatedAtMixin, Base):
    __tablename__ = "bot_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    bot_id: Mapped[int] = mapped_column(
        ForeignKey("bots.id", ondelete="CASCADE"), index=True, nullable=False
    )

    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    stage: Mapped[str | None] = mapped_column(String(64), default=None)
    trigger: Mapped[str] = mapped_column(
        String(32), default=BotRunTrigger.MANUAL.value, nullable=False
    )
    progress: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    stats: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    events: Mapped[list[Any]] = mapped_column(JSON, default=list, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class BotPreset(TimestampMixin, Base):
    __tablename__ = "bot_presets"

    id: Mapped[int] = mapped_column(primary_key=True)
    # NULL owner => a built-in/system preset.
    owner_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, default=None
    )
    key: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, default=None)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    based_on: Mapped[str | None] = mapped_column(String(64), default=None)
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
