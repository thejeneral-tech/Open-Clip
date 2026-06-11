from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import SourceListMode, SourcePlatform


class TrendSourceCreate(BaseModel):
    platform: SourcePlatform = SourcePlatform.RSS
    name: str = Field(min_length=1, max_length=255)
    identifier: str = Field(min_length=1)
    list_mode: SourceListMode = SourceListMode.ALLOW
    enabled: bool = True
    config: dict[str, Any] = Field(default_factory=dict)


class TrendSourceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    identifier: str | None = None
    list_mode: SourceListMode | None = None
    enabled: bool | None = None
    config: dict[str, Any] | None = None


class TrendSourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    bot_id: int | None
    platform: str
    name: str
    identifier: str
    list_mode: str
    enabled: bool
    config: dict[str, Any]
    last_polled_at: datetime | None
    last_error: str | None
    created_at: datetime


class TrendItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    bot_id: int
    source_id: int | None
    video_id: int | None
    platform: str
    external_id: str
    url: str
    title: str | None
    author: str | None
    description: str | None
    thumbnail_url: str | None
    language: str | None
    duration_seconds: float | None
    published_at: datetime | None
    metrics: dict[str, Any]
    score_breakdown: dict[str, Any]
    trend_score: float
    status: str
    reason: str | None
    created_at: datetime
