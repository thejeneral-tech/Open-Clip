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
    project_id: int | None = None
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


class SvBackgroundImport(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
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
    background_id: int | None = None   # pin gameplay footage to one background
    script_engine: str = "auto"        # auto|ai|heuristic
    project_id: int | None = None      # file the video under a project folder
    template_id: int | None = None     # snapshot this preset's caption config


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
    background_id: int | None = None
    script_engine: str
    project_id: int | None = None
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
    engine: str = "sapi"
    preview_url: str | None = None
    created_at: datetime


# ---- Voice cloning (Fish Speech S2) ----
class SvCloneStatusOut(BaseModel):
    reachable: bool
    url: str


class SvCloneUploadOut(BaseModel):
    reference_id: str
    filename: str


class SvCloneTranscribeRequest(BaseModel):
    reference_id: str = Field(min_length=1, max_length=64)


class SvCloneTranscribeOut(BaseModel):
    ok: bool
    transcript: str = ""
    note: str | None = None


class SvCloneGenerateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    reference_id: str | None = Field(default=None, max_length=64)
    prompt_text: str = Field(default="", max_length=2000)
    temperature: float | None = Field(default=None, ge=0.0, le=1.5)


class SvCloneGenerateOut(BaseModel):
    media_url: str
    duration: float
    bytes: int


class SvCloneModelsOut(BaseModel):
    quants: list[str]
    quant: str
    default_quant: str
    model_dir: str
    present: list[str]
    reachable: bool
    url: str


class SvCloneQuantRequest(BaseModel):
    quant: str = Field(min_length=1, max_length=32)


class SvCaptionPreviewOut(BaseModel):
    style: str
    media_url: str | None = None


# -------------------------------------------------------------------- templates
class SvTemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    # Optional base config blob; when omitted the default template is cloned.
    data: dict[str, Any] | None = None


class SvTemplateUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    data: dict[str, Any] | None = None


class SvTemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    builtin: bool
    is_default: bool
    # Full render-config blob (canvas, captions, topicCard, gameplay, audio…).
    data: dict[str, Any]
    created_at: datetime


# ---------------------------------------------------------------- publishing
class SvPublishRequest(BaseModel):
    connector_ids: list[int] = Field(min_length=1, max_length=10)
    title: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=5000)
    privacy: str = "public"  # public|unlisted|private


class SvPublishJobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    sv_video_id: int
    connector_id: int | None = None
    platform: str
    status: str
    title: str | None = None
    published_at: datetime | None = None
    external_url: str | None = None
    error: str | None = None
    created_at: datetime
    # Enriched by the endpoint:
    video_title: str | None = None
    channel_name: str | None = None


# ------------------------------------------------------------------ projects
class SvProjectSettings(BaseModel):
    """The reusable 'auto-workflow' recipe stored on a project.

    Every field has a sensible default so a half-configured project still runs.
    """

    # Where stories come from.
    story_source: str = "reddit"                       # reddit|manual
    communities: list[str] = Field(default_factory=list, max_length=20)
    discovery_sort: str = "top"                        # hot|top|new|rising
    discovery_time_window: str = "week"                # hour|day|week|month|year|all
    min_upvotes: int = Field(default=500, ge=0)
    min_length: int = Field(default=600, ge=0)

    # How each video is built (mirrors the Video Studio knobs).
    duration_target: int = Field(default=60, ge=15, le=300)
    hook_style: str = "conflict"
    narration_style: str = "dramatic"
    drama_level: int = Field(default=3, ge=1, le=5)
    voice: str | None = None                           # "preset:<id>" | SAPI name | null=auto
    speed: float = Field(default=1.0, ge=0.7, le=1.4)
    caption_style: str = "modern_tiktok"
    background_category: str | None = None
    background_id: int | None = None
    template_id: int | None = None
    script_engine: str = "auto"                        # auto|ai|heuristic

    # Publishing.
    publish_connector_ids: list[int] = Field(default_factory=list, max_length=10)
    privacy: str = "public"                            # public|unlisted|private

    # Orchestration.
    videos_per_run: int = Field(default=3, ge=1, le=25)
    auto_publish: bool = False                         # render + queue publishing without review


class SvProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    settings: SvProjectSettings = Field(default_factory=SvProjectSettings)


class SvProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    settings: SvProjectSettings | None = None


class SvProjectOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None = None
    settings: SvProjectSettings
    created_at: datetime
    updated_at: datetime
    # Enriched by the endpoint — the project's pipeline at a glance.
    stories_total: int = 0
    stories_ready: int = 0          # new|saved|approved (not yet used)
    videos_total: int = 0
    videos_in_pipeline: int = 0     # queued|processing|rendering
    videos_in_review: int = 0       # ready_for_review
    videos_completed: int = 0       # completed
    videos_published: int = 0       # has a published publish-job


class SvProjectRunResult(BaseModel):
    stories_added: int
    videos_queued: int
    detail: str


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
