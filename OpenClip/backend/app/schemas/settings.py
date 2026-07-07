from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import (
    AspectRatio,
    CaptionStyle,
    ExportFormat,
    ExportResolution,
)


class SettingsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    default_model: str
    ranking_model: str
    vision_model: str
    whisper_model: str
    target_clip_count: int
    min_clip_seconds: int
    max_clip_seconds: int
    default_aspect_ratio: AspectRatio
    default_caption_style: CaptionStyle
    default_export_format: ExportFormat
    default_export_resolution: ExportResolution
    reframe_hq_detection: bool = False
    reframe_face_zoom: bool = False
    preferences: dict[str, Any] = {}


class SettingsUpdate(BaseModel):
    default_model: str | None = None
    ranking_model: str | None = None
    vision_model: str | None = None
    whisper_model: str | None = None
    target_clip_count: int | None = Field(default=None, ge=1, le=50)
    min_clip_seconds: int | None = Field(default=None, ge=3, le=300)
    max_clip_seconds: int | None = Field(default=None, ge=5, le=600)
    default_aspect_ratio: AspectRatio | None = None
    default_caption_style: CaptionStyle | None = None
    default_export_format: ExportFormat | None = None
    default_export_resolution: ExportResolution | None = None
    reframe_hq_detection: bool | None = None
    reframe_face_zoom: bool | None = None
    preferences: dict[str, Any] | None = None


class OllamaModelInfo(BaseModel):
    name: str
    size: int | None = None
    parameter_size: str | None = None
    family: str | None = None
    modified_at: str | None = None
