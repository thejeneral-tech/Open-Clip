"""Whop Campaigns request/response schemas."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.enums import WHOP_PLATFORMS, WhopCampaignStatus, WhopCampaignType

_CAMPAIGN_TYPES = {t.value for t in WhopCampaignType}
_CAMPAIGN_STATUSES = {s.value for s in WhopCampaignStatus}


def _check_campaign_type(value: str | None) -> str | None:
    if value is not None and value not in _CAMPAIGN_TYPES:
        raise ValueError(f"Unknown campaign type {value!r}")
    return value


def _check_platforms(value: list[str] | None) -> list[str] | None:
    for platform in value or []:
        if platform not in WHOP_PLATFORMS:
            raise ValueError(f"Unknown platform {platform!r}")
    return value


def _check_requirements(value: list[str] | None) -> list[str] | None:
    for requirement in value or []:
        if len(requirement) > 280:
            raise ValueError("Each requirement must be 280 characters or fewer")
    return value


# ----------------------------------------------------------------- campaigns
class WhopAssetLink(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=1, max_length=500)


class WhopCampaignCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    campaign_type: str = "clipping"    # clipping|ugc|faceless
    # personal_brand|products|education|entertainment|music|gaming|other
    category: str = "personal_brand"
    rate_per_1k: float = Field(default=1.0, gt=0, le=1000)
    budget: float | None = Field(default=None, ge=0)       # None = unlimited
    min_payout: float | None = Field(default=None, ge=0)
    max_payout: float | None = Field(default=None, ge=0)   # per-submission cap
    platforms: list[str] = Field(default_factory=list)     # tiktok|instagram|youtube|x
    requirements: list[str] = Field(default_factory=list, max_length=25)
    asset_links: list[WhopAssetLink] = Field(default_factory=list, max_length=10)
    whop_url: str | None = Field(default=None, max_length=500)
    ends_at: datetime | None = None

    _campaign_type = field_validator("campaign_type")(_check_campaign_type)
    _platforms = field_validator("platforms")(_check_platforms)
    _requirements = field_validator("requirements")(_check_requirements)


class WhopCampaignUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    campaign_type: str | None = None   # clipping|ugc|faceless
    category: str | None = None
    status: str | None = None          # active|paused|ended
    rate_per_1k: float | None = Field(default=None, gt=0, le=1000)
    budget: float | None = Field(default=None, ge=0)
    min_payout: float | None = Field(default=None, ge=0)
    max_payout: float | None = Field(default=None, ge=0)
    platforms: list[str] | None = None
    requirements: list[str] | None = Field(default=None, max_length=25)
    asset_links: list[WhopAssetLink] | None = Field(default=None, max_length=10)
    whop_url: str | None = Field(default=None, max_length=500)
    ends_at: datetime | None = None

    _campaign_type = field_validator("campaign_type")(_check_campaign_type)
    _platforms = field_validator("platforms")(_check_platforms)
    _requirements = field_validator("requirements")(_check_requirements)

    @field_validator("status")
    @classmethod
    def _check_status(cls, value: str | None) -> str | None:
        if value is not None and value not in _CAMPAIGN_STATUSES:
            raise ValueError(f"Unknown campaign status {value!r}")
        return value


class WhopCampaignOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None = None
    campaign_type: str
    category: str
    status: str
    rate_per_1k: float
    budget: float | None = None
    min_payout: float | None = None
    max_payout: float | None = None
    platforms: list[str]
    requirements: list[str]
    asset_links: list[WhopAssetLink]
    whop_url: str | None = None
    ends_at: datetime | None = None
    studio_project_id: int | None = None
    created_at: datetime
    updated_at: datetime
    # Enriched by the endpoint:
    thumbnail_url: str | None = None
    submissions_total: int = 0
    submissions_pending: int = 0
    submissions_approved: int = 0
    submissions_rejected: int = 0
    submissions_paid: int = 0
    views_total: int = 0
    paid_out: float = 0
    pending_payout: float = 0
    budget_used_pct: float | None = None
    days_left: int | None = None


class WhopStudioOut(BaseModel):
    """The OpenClip Project that backs a campaign's Studio clip workspace."""

    project_id: int
    campaign_id: int


# ------------------------------------------------------------------ formulas
class WhopFormulaCreate(BaseModel):
    """Kick off a clip-formula analysis of an already-ingested source video."""

    video_id: int


class WhopFormulaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    campaign_id: int
    video_id: int | None = None
    title: str | None = None
    source_url: str | None = None
    status: str                     # processing|completed|failed
    stage: str | None = None
    progress: float = 0.0
    error: str | None = None
    hook_score: int | None = None
    # The full section-by-section breakdown; null until status == completed.
    result: dict | None = None
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------- auto video finder
class WhopScoreFactor(BaseModel):
    """One weighted component of a video's Auto Finder Score."""

    key: str
    label: str
    weight: float
    value: float                    # 0-100
    measured: bool                  # True = real data this stage; False = prior/estimate


class WhopScoreReason(BaseModel):
    kind: str                       # "ok" | "warn"
    text: str


class WhopVideoMatch(BaseModel):
    """A YouTube candidate the finder scored against the campaign."""

    url: str
    title: str
    duration: float | None = None
    uploader: str | None = None
    thumbnail: str | None = None
    view_count: int | None = None
    score: int                      # 0-100 Auto Finder Score
    reason: str
    # --- staged Auto Finder Score detail (optional; present once scored) ---
    stage: int | None = None        # 1..4 — how deep the analysis got
    confidence: int | None = None   # 0-100 — how much weight is real vs. prior
    delta: int | None = None        # change vs. the previous stage's score
    factors: list[WhopScoreFactor] = Field(default_factory=list)
    reasons: list[WhopScoreReason] = Field(default_factory=list)
    projected_low: float | None = None    # projected clip earnings range ($)
    projected_high: float | None = None
    # Densest viral-language stretch in the transcript — a candidate clip moment
    # (seconds), present once a transcript has been read (Stage 4).
    best_moment_start: float | None = None
    best_moment_end: float | None = None


class WhopFindBody(BaseModel):
    """Optional refinements for the auto video finder."""

    limit: int = Field(default=12, ge=3, le=24)
    use_llm: bool = True
    # Pin a creator (name, @handle, or URL). A plain name is resolved to that
    # creator's actual channel.
    channel: str | None = Field(default=None, max_length=300)
    # Return ONLY that creator's own videos (drop other people's videos about them).
    strict_channel: bool = False
    # Words to steer the search + ranking toward.
    filters: list[str] = Field(default_factory=list, max_length=20)


class WhopFindOut(BaseModel):
    understanding: str              # what the finder read + searched for
    queries: list[str]
    matches: list[WhopVideoMatch]


class WhopScoreBody(BaseModel):
    """Re-score specific candidates at a deeper stage (Auto Finder deepening)."""

    urls: list[str] = Field(min_length=1, max_length=24)
    stage: int = Field(default=3, ge=1, le=4)
    # Previous score per url so the deeper pass can report a delta (e.g. "94 (+7)").
    prev_scores: dict[str, int] = Field(default_factory=dict)


class WhopScoreOut(BaseModel):
    matches: list[WhopVideoMatch]


# ----------------------------------------------------------- campaign copilot
class WhopStrategyVideo(BaseModel):
    """A scored candidate the copilot reasons over (sent by the client)."""

    url: str
    title: str
    score: int = 0
    duration: float | None = None
    projected_low: float | None = None
    projected_high: float | None = None
    reasons: list[str] = Field(default_factory=list, max_length=6)


class WhopStrategyBody(BaseModel):
    videos: list[WhopStrategyVideo] = Field(default_factory=list, max_length=12)


class WhopStrategyOut(BaseModel):
    opportunity_score: int = 0
    recommended_index: int | None = None
    recommended_url: str | None = None
    recommended_title: str | None = None
    headline: str
    reasoning: list[str] = Field(default_factory=list)
    clip_plan: str = ""
    worth_joining: bool = False
    source: str = "heuristic"          # "ai" | "heuristic"


# ------------------------------------------------------------------ publishing
class WhopReadyClip(BaseModel):
    """A rendered campaign clip ready to publish to a channel."""

    id: int
    title: str | None = None
    duration: float = 0.0
    thumbnail_url: str | None = None
    preview_url: str | None = None
    # Latest publish attempt for this clip, if any.
    publish_status: str | None = None       # queued|publishing|published|failed|…
    external_url: str | None = None


class WhopPublishBody(BaseModel):
    clip_id: int
    connector_id: int                       # the YouTube channel to publish to


class WhopPublishOut(BaseModel):
    clip_id: int
    job_id: int
    status: str


# ------------------------------------------------------------------ channels
# A "channel" is a connected YouTube publishing connector, surfaced in the Review
# section so campaigns and submissions can be organized per channel.
class WhopChannelOut(BaseModel):
    connector_id: int
    name: str
    channel_id: str | None = None
    channel_title: str | None = None
    channel_thumbnail: str | None = None
    status: str
    has_credentials: bool = False
    # Enriched by the endpoint (manual ∪ auto-detected):
    campaigns_connected: int = 0
    submissions_pending: int = 0
    submissions_total: int = 0


class WhopChannelCampaignOut(BaseModel):
    """A campaign connected to a channel, tagged with how the link was made."""

    campaign: WhopCampaignOut
    source: str  # "manual" (user pinned) | "auto" (matched from a submission)


class WhopChannelLinkBody(BaseModel):
    campaign_id: int


class WhopUrlPreviewOut(BaseModel):
    """Link-preview metadata scraped from a pasted whop.com URL."""

    url: str
    title: str | None = None
    description: str | None = None
    image: str | None = None
    site_name: str | None = None


class WhopImportItem(BaseModel):
    """One campaign in a bulk import (e.g. scraped from the Whop marketplace)."""

    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    campaign_type: str = "clipping"
    category: str = "other"
    status: str = "active"           # active|paused|ended
    rate_per_1k: float = Field(default=1.0, gt=0, le=1000)
    budget: float | None = Field(default=None, ge=0)
    platforms: list[str] = Field(default_factory=list)
    whop_url: str | None = Field(default=None, max_length=500)

    _campaign_type = field_validator("campaign_type")(_check_campaign_type)
    _platforms = field_validator("platforms")(_check_platforms)

    @field_validator("status")
    @classmethod
    def _check_status(cls, value: str) -> str:
        if value not in _CAMPAIGN_STATUSES:
            raise ValueError(f"Unknown campaign status {value!r}")
        return value


class WhopImportBody(BaseModel):
    campaigns: list[WhopImportItem] = Field(max_length=5000)
    source: str = Field(default="whop_marketplace", max_length=64)
    # When true, campaigns with this source that are NOT in `campaigns` are marked
    # ended (they left the marketplace). Guarded so a partial scrape can't mass-end.
    reconcile: bool = False


class WhopImportResult(BaseModel):
    total: int
    created: int
    updated: int
    ended: int       # reconciled to ended because they left the marketplace
    reconciled: bool  # whether the reconcile pass actually ran (vs skipped by guard)


# --------------------------------------------------------------- submissions
class WhopSubmissionCreate(BaseModel):
    platform: str = "tiktok"           # tiktok|instagram|youtube|x
    post_url: str = Field(min_length=1, max_length=500)
    title: str | None = Field(default=None, max_length=255)
    creator_handle: str | None = Field(default=None, max_length=120)
    views: int = Field(default=0, ge=0)
    likes: int = Field(default=0, ge=0)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("platform")
    @classmethod
    def _check_platform(cls, value: str) -> str:
        if value not in WHOP_PLATFORMS:
            raise ValueError(f"Unknown platform {value!r}")
        return value


class WhopSubmissionUpdate(BaseModel):
    platform: str | None = None        # tiktok|instagram|youtube|x
    post_url: str | None = Field(default=None, min_length=1, max_length=500)
    title: str | None = Field(default=None, max_length=255)
    creator_handle: str | None = Field(default=None, max_length=120)
    views: int | None = Field(default=None, ge=0)
    likes: int | None = Field(default=None, ge=0)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("platform")
    @classmethod
    def _check_platform(cls, value: str | None) -> str | None:
        if value is not None and value not in WHOP_PLATFORMS:
            raise ValueError(f"Unknown platform {value!r}")
        return value


class WhopReasonBody(BaseModel):
    """Optional free-text reason used by the reject and clawback actions."""

    reason: str | None = Field(default=None, max_length=2000)


class WhopSubmissionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    campaign_id: int
    creator_handle: str | None = None
    platform: str
    post_url: str
    title: str | None = None
    status: str
    views: int
    likes: int
    paid_amount: float
    rejection_reason: str | None = None
    clawback_requested: bool
    clawback_reason: str | None = None
    notes: str | None = None
    created_at: datetime
    updated_at: datetime
    # Enriched by the endpoint:
    earnings_estimate: float = 0
    campaign_name: str | None = None
    rate_per_1k: float = 0


# ----------------------------------------------------- dashboard & analytics
class WhopDashboardOut(BaseModel):
    campaigns_active: int
    campaigns_total: int
    submissions_pending: int
    submissions_total: int
    views_total: int
    paid_out: float
    pending_payout: float
    approval_rate: float
    recent_submissions: list[WhopSubmissionOut]
    campaigns: list[WhopCampaignOut]


class WhopAnalyticsPoint(BaseModel):
    date: str                          # YYYY-MM-DD
    views: int
    earnings: float


class WhopCampaignStat(BaseModel):
    campaign_id: int
    name: str
    submissions: int
    views: int
    earnings: float


class WhopAnalyticsOut(BaseModel):
    days: int
    views_total: int
    earnings_total: float
    effective_cpm: float               # earnings_total / views_total * 1000, 0 when no views
    submissions_total: int
    approval_rate: float
    series: list[WhopAnalyticsPoint]
    campaigns: list[WhopCampaignStat]
