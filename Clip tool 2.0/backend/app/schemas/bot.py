from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import ApprovalMode, BotStatus


class BotBase(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    bot_type: str = "custom"
    approval_mode: ApprovalMode = ApprovalMode.MANUAL


class BotCreate(BotBase):
    # Seed the bot's config from a preset (built-in key or a user preset id).
    preset_key: str = "CUSTOM"
    preset_id: int | None = None
    # Optional overrides applied on top of the preset's resolved config.
    config_overrides: dict[str, Any] = Field(default_factory=dict)
    model_assignments: dict[str, Any] = Field(default_factory=dict)
    schedule_config: dict[str, Any] = Field(default_factory=dict)


class BotUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    bot_type: str | None = None
    approval_mode: ApprovalMode | None = None
    status: BotStatus | None = None
    model_assignments: dict[str, Any] | None = None
    discovery_config: dict[str, Any] | None = None
    filter_config: dict[str, Any] | None = None
    scoring_config: dict[str, Any] | None = None
    clipping_config: dict[str, Any] | None = None
    publishing_config: dict[str, Any] | None = None
    schedule_config: dict[str, Any] | None = None


class BotOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    owner_id: int
    project_id: int | None
    name: str
    description: str | None
    bot_type: str
    preset_key: str
    status: str
    approval_mode: str
    model_assignments: dict[str, Any]
    discovery_config: dict[str, Any]
    filter_config: dict[str, Any]
    scoring_config: dict[str, Any]
    clipping_config: dict[str, Any]
    publishing_config: dict[str, Any]
    schedule_config: dict[str, Any]
    stats: dict[str, Any]
    insights: dict[str, Any]
    last_run_at: datetime | None
    next_run_at: datetime | None
    last_error: str | None
    created_at: datetime
    updated_at: datetime
    source_count: int = 0


class BotRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    bot_id: int
    status: str
    stage: str | None
    trigger: str
    progress: float
    stats: dict[str, Any]
    events: list[Any]
    error: str | None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime


class BotExport(BaseModel):
    """Portable bot definition (no owner/runtime state) for export/import."""

    name: str
    description: str | None = None
    bot_type: str = "custom"
    approval_mode: str = ApprovalMode.MANUAL.value
    preset_key: str = "CUSTOM"
    config: dict[str, Any]
    model_assignments: dict[str, Any] = Field(default_factory=dict)
    schedule_config: dict[str, Any] = Field(default_factory=dict)
    sources: list[dict[str, Any]] = Field(default_factory=list)
    version: int = 1
