from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.enums import (
    AspectRatio,
    ExportFormat,
    ExportResolution,
    JobStatus,
)


class ExportCreate(BaseModel):
    format: ExportFormat = ExportFormat.MP4
    resolution: ExportResolution = ExportResolution.P1080
    aspect_ratio: AspectRatio = AspectRatio.VERTICAL
    burn_captions: bool = True


class ExportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    clip_id: int
    format: ExportFormat
    resolution: ExportResolution
    aspect_ratio: AspectRatio
    burn_captions: bool
    hwaccel: str | None = None
    storage_path: str | None = None
    size_bytes: int | None = None
    width: int | None = None
    height: int | None = None
    duration_seconds: float | None = None
    status: JobStatus
    progress: float
    error: str | None = None
    created_at: datetime
