from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import AspectRatio, CaptionStyle, JobStatus


class ScoreBreakdown(BaseModel):
    hook_strength: float = 0
    emotional_intensity: float = 0
    curiosity_gap: float = 0
    retention_likelihood: float = 0
    platform_suitability: float = 0
    explanation: str | None = None


class CaptionToken(BaseModel):
    word: str
    start: float
    end: float
    emphasis: bool = False
    emoji: str | None = None


class ClipOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    video_id: int
    order_index: int
    start_time: float
    end_time: float
    duration: float
    title: str | None = None
    reasoning: str | None = None
    transcript_text: str | None = None
    description: str | None = None
    viral_score: float
    ranking_score: float
    confidence: float
    score_breakdown: dict[str, Any] = {}
    aspect_ratio: AspectRatio
    caption_style: CaptionStyle
    title_variations: list[str] = []
    hashtags: list[str] = []
    keywords: list[str] = []
    broll_suggestions: list[dict[str, Any]] = []
    captions: list[dict[str, Any]] = []
    reframe_data: dict[str, Any] = {}
    preview_path: str | None = None
    thumbnail_path: str | None = None
    status: JobStatus
    progress: float
    error: str | None = None
    created_at: datetime
    updated_at: datetime


class ClipUpdate(BaseModel):
    """Edits coming from the browser timeline editor."""

    title: str | None = None
    description: str | None = None
    start_time: float | None = Field(default=None, ge=0)
    end_time: float | None = Field(default=None, ge=0)
    aspect_ratio: AspectRatio | None = None
    caption_style: CaptionStyle | None = None
    captions: list[dict[str, Any]] | None = None
    reframe_data: dict[str, Any] | None = None
    order_index: int | None = None


class ClipRegenerateRequest(BaseModel):
    """Re-run a specific AI step for a single clip."""

    regenerate_captions: bool = False
    regenerate_titles: bool = False
    regenerate_description: bool = False
    regenerate_broll: bool = False
    rerank: bool = False
