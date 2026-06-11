"""Story Vault request/response schemas."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


# ------------------------------------------------------------------- stories
class SvDiscoverySearch(BaseModel):
    communities: list[str] = Field(min_length=1, max_length=10)
    sort: str = "top"                  # hot|top|new|rising
    time_window: str = "week"          # hour|day|week|month|year|all
    limit: int = Field(default=25, ge=1, le=100)
    min_upvotes: int = Field(default=0, ge=0)
    min_length: int = Field(default=300, ge=0)


class SvStoryImport(BaseModel):
    title: str = Field(min_length=1, max_length=512)
    body: str = Field(min_length=1)
    category: str | None = None
    source_url: str | None = None


class SvStoryUpdate(BaseModel):
    status: str | None = None          # new|saved|approved|used|excluded
    category: str | None = None


class SvStoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source: str
    source_url: str | None = None
    community: str | None = None
    author: str | None = None
    title: str
    body: str
    category: str | None = None
    upvotes: int
    num_comments: int
    score: float
    score_breakdown: dict[str, Any] | None = None
    status: str
    created_at: datetime


class SvDiscoveryResult(BaseModel):
    fetched: int
    added: int
    duplicates: int
    stories: list[SvStoryOut]


class SvScriptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    story_id: int
    full_text: str
    hook: str | None = None
    duration_target: int
    hook_style: str
    narration_style: str
    drama_level: int
    word_count: int
    generator: str | None = None
    created_at: datetime


# --------------------------------------------------------------- backgrounds
class SvBackgroundOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    original_filename: str | None = None
    category: str | None = None
    duration_seconds: float | None = None
    width: int | None = None
    height: int | None = None
    size_bytes: int | None = None
    status: str
    error: str | None = None
    created_at: datetime
    # Enriched by the endpoint:
    thumbnail_url: str | None = None
    segment_count: int = 0


class SvBackgroundUpdate(BaseModel):
    category: str | None = None


# -------------------------------------------------------------------- videos
class SvVideoCreate(BaseModel):
    story_id: int
    duration_target: int = Field(default=60, ge=15, le=300)
    hook_style: str = "conflict"
    narration_style: str = "dramatic"
    drama_level: int = Field(default=3, ge=1, le=5)
    voice: str | None = None
    speed: float = Field(default=1.0, ge=0.7, le=1.4)
    caption_style: str = "hormozi"
    background_category: str | None = None
    script_engine: str = "auto"        # auto|ai|heuristic


class SvVideoReject(BaseModel):
    reason: str | None = None


class SvVideoApprove(BaseModel):
    platform: str = "tiktok"           # tiktok|shorts|reels


class SvVideoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    story_id: int
    script_id: int | None = None
    title: str | None = None
    duration_target: int
    hook_style: str
    narration_style: str
    drama_level: int
    voice: str | None = None
    speed: float
    caption_style: str
    background_category: str | None = None
    script_engine: str
    narration_duration: float | None = None
    status: str
    stage: str | None = None
    progress: float
    error: str | None = None
    reject_reason: str | None = None
    created_at: datetime
    updated_at: datetime
    # Enriched by the endpoint:
    preview_url: str | None = None
    render_url: str | None = None
    script_text: str | None = None
    story_title: str | None = None


# ------------------------------------------------------------------- exports
class SvExportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    sv_video_id: int
    platform: str
    title: str | None = None
    size_bytes: int | None = None
    duration_seconds: float | None = None
    width: int | None = None
    height: int | None = None
    created_at: datetime
    # Enriched by the endpoint:
    media_url: str | None = None


# --------------------------------------------------------------------- misc
class SvVoiceOut(BaseModel):
    name: str
    culture: str | None = None
    gender: str | None = None


class SvVoiceSampleRequest(BaseModel):
    text: str = Field(
        default="Hi! This is a Story Vault voice test. Stories sound better out loud.",
        max_length=400,
    )
    voice: str | None = None
    speed: float = Field(default=1.0, ge=0.7, le=1.4)


class SvVoiceSampleOut(BaseModel):
    media_url: str
    duration: float


class SvVoicePresetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    voice: str = Field(min_length=1, max_length=128)
    speed: float = Field(default=1.0, ge=0.7, le=1.4)


class SvVoicePresetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    voice: str | None = None
    speed: float | None = Field(default=None, ge=0.7, le=1.4)


class SvVoicePresetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    voice: str
    speed: float
    is_default: bool
    created_at: datetime


class SvCaptionPreviewOut(BaseModel):
    style: str
    media_url: str | None = None


class SvDashboardOut(BaseModel):
    stories_total: int
    stories_new: int
    stories_approved: int
    backgrounds_ready: int
    segments_total: int
    videos_in_pipeline: int
    videos_in_review: int
    exports_total: int
    recent_videos: list[SvVideoOut]


class SvMetaOut(BaseModel):
    hook_styles: list[str]
    narration_styles: list[str]
    durations: list[int]
    categories: list[str]
    background_categories: list[str]
    caption_styles: list[str]
    platforms: list[str]
