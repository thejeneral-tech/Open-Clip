from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, HttpUrl

from app.models.enums import (
    AspectRatio,
    CaptionStyle,
    JobStatus,
    VideoSource,
)


class YouTubeImportRequest(BaseModel):
    url: HttpUrl
    title: str | None = None


class ProcessOptions(BaseModel):
    """Options that drive the analysis pipeline for a video."""

    target_clip_count: int = Field(12, ge=1, le=50)
    min_clip_seconds: int = Field(8, ge=3, le=120)
    max_clip_seconds: int = Field(90, ge=5, le=180)
    aspect_ratios: list[AspectRatio] = Field(default_factory=lambda: [AspectRatio.VERTICAL])
    # Base named style (font / outline / layout defaults). The caption look is
    # refined by ``caption_config`` (karaoke/pop + colours) and an optional preset.
    caption_style: CaptionStyle = CaptionStyle.HORMOZI
    # Caption override blob: {"style": "karaoke"|"pop", "primary": "#RRGGBB",
    # "highlight": "#RRGGBB"}. Layered on top of the named style at render time.
    caption_config: dict[str, Any] | None = None
    # Optional preset (Story Vault template) whose caption config seeds the look.
    template_id: int | None = None
    language: str | None = None
    generate_titles: bool = True
    generate_descriptions: bool = True
    generate_broll: bool = True
    enable_reframe: bool = True
    enable_captions: bool = True
    model: str | None = None


class VideoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    source: VideoSource
    source_url: str | None = None
    original_filename: str | None = None
    title: str | None = None
    language: str | None = None
    duration_seconds: float | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    size_bytes: int | None = None
    thumbnail_path: str | None = None
    status: JobStatus
    stage: str | None = None
    progress: float
    error: str | None = None
    created_at: datetime
    updated_at: datetime
    clip_count: int = 0
