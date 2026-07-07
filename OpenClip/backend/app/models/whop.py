"""Whop Campaigns models — clipping & UGC reward campaigns.

A campaign pays creators ``rate_per_1k`` dollars per 1,000 views on approved
submissions. Submissions move pending → approved → paid (or rejected); every
change to a submission's view count is journalled into ``whop_view_snapshots``
so the analytics charts can derive daily view deltas. Tables are prefixed
``whop_`` to keep the module self-contained next to the other feature tables.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.enums import WhopCampaignStatus, WhopCampaignType, WhopSubmissionStatus
from app.models.mixins import CreatedAtMixin, TimestampMixin


class WhopCampaign(TimestampMixin, Base):
    __tablename__ = "whop_campaigns"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, default=None)
    campaign_type: Mapped[str] = mapped_column(
        String(32), default=WhopCampaignType.CLIPPING.value, nullable=False
    )  # clipping|ugc|faceless
    category: Mapped[str] = mapped_column(String(64), default="personal_brand", nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), default=WhopCampaignStatus.ACTIVE.value, nullable=False, index=True
    )

    rate_per_1k: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)  # $ per 1,000 views
    budget: Mapped[float | None] = mapped_column(Float, default=None)      # None = unlimited
    min_payout: Mapped[float | None] = mapped_column(Float, default=None)
    max_payout: Mapped[float | None] = mapped_column(Float, default=None)  # per-submission cap

    platforms: Mapped[list] = mapped_column(JSON, default=list, nullable=False)     # list[str]
    requirements: Mapped[list] = mapped_column(JSON, default=list, nullable=False)  # list[str]
    asset_links: Mapped[list] = mapped_column(JSON, default=list, nullable=False)   # [{label, url}]
    whop_url: Mapped[str | None] = mapped_column(String(500), default=None)
    thumbnail_path: Mapped[str | None] = mapped_column(String(500), default=None)   # storage key, NOT url
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    # Provenance: "whop_marketplace" for campaigns scraped/imported from Whop's
    # public marketplace. Only these are touched by the import reconcile pass.
    source: Mapped[str | None] = mapped_column(String(64), default=None, index=True)

    # Auto-provisioned OpenClip Project used as this campaign's Studio clip workspace.
    studio_project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), index=True, nullable=True, default=None
    )


class WhopFormula(TimestampMixin, Base):
    """A reverse-engineered "clip formula" for a campaign source video.

    The Studio can analyze a source video — its transcript plus the campaign's
    rules — into a reusable, section-by-section breakdown (hook · script
    psychology · retention editing · viral timestamps · recreation plan ·
    submission checklist) so the winning formula can be repeated and automated.
    The heavy work runs in ``analyze_formula_task``; ``result`` holds the finished
    structured breakdown once ``status`` becomes ``completed``.
    """

    __tablename__ = "whop_formulas"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    campaign_id: Mapped[int] = mapped_column(
        ForeignKey("whop_campaigns.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # The analyzed source video. SET NULL so pruning a video keeps the formula.
    video_id: Mapped[int | None] = mapped_column(
        ForeignKey("videos.id", ondelete="SET NULL"), index=True, nullable=True, default=None
    )

    title: Mapped[str | None] = mapped_column(String(512), default=None)
    source_url: Mapped[str | None] = mapped_column(String(1000), default=None)

    status: Mapped[str] = mapped_column(
        String(32), default="processing", nullable=False, index=True
    )  # processing|completed|failed
    stage: Mapped[str | None] = mapped_column(String(64), default=None)
    progress: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, default=None)

    # 1-10 hook rating, surfaced on the card without opening the full report.
    hook_score: Mapped[int | None] = mapped_column(Integer, default=None)
    # The full multi-section structured breakdown (see services/clip_formula.py).
    result: Mapped[dict | None] = mapped_column(JSON, default=None)

    celery_task_id: Mapped[str | None] = mapped_column(String(64), default=None)


class WhopSubmission(TimestampMixin, Base):
    __tablename__ = "whop_submissions"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    campaign_id: Mapped[int] = mapped_column(
        ForeignKey("whop_campaigns.id", ondelete="CASCADE"), index=True, nullable=False
    )

    creator_handle: Mapped[str | None] = mapped_column(String(120), default=None)
    platform: Mapped[str] = mapped_column(String(32), default="tiktok", nullable=False)
    post_url: Mapped[str] = mapped_column(String(500), nullable=False)
    title: Mapped[str | None] = mapped_column(String(255), default=None)
    status: Mapped[str] = mapped_column(
        String(32), default=WhopSubmissionStatus.PENDING.value, nullable=False, index=True
    )

    views: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    likes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Set by the "pay" action: the earnings estimate frozen at payment time.
    paid_amount: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    rejection_reason: Mapped[str | None] = mapped_column(Text, default=None)
    # Flags an approved/paid submission for clawback; paid totals still include
    # it — the UI surfaces a warning badge instead of reversing the payout.
    clawback_requested: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    clawback_reason: Mapped[str | None] = mapped_column(Text, default=None)
    notes: Mapped[str | None] = mapped_column(Text, default=None)


class WhopChannelCampaign(CreatedAtMixin, Base):
    """A manual link between a YouTube channel (publishing connector) and a campaign.

    Only *manual* links are stored here — the "auto" links a channel gets from its
    submissions are derived at read time (see ``whop.py`` endpoints), never
    persisted. Presence of a row means the user explicitly pinned this campaign to
    this channel. Unique per (connector, campaign) so re-linking is idempotent.
    """

    __tablename__ = "whop_channel_campaigns"
    __table_args__ = (
        UniqueConstraint("connector_id", "campaign_id", name="uq_whop_channel_campaign"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    connector_id: Mapped[int] = mapped_column(
        ForeignKey("publishing_connectors.id", ondelete="CASCADE"), index=True, nullable=False
    )
    campaign_id: Mapped[int] = mapped_column(
        ForeignKey("whop_campaigns.id", ondelete="CASCADE"), index=True, nullable=False
    )


class WhopViewSnapshot(CreatedAtMixin, Base):
    """A point-in-time view count for a submission.

    A row is inserted whenever a submission's ``views`` value changes (create
    with views > 0, PATCH, or any action that changes views). The analytics
    series derives daily view deltas from these snapshots.
    """

    __tablename__ = "whop_view_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    submission_id: Mapped[int] = mapped_column(
        ForeignKey("whop_submissions.id", ondelete="CASCADE"), index=True, nullable=False
    )
    views: Mapped[int] = mapped_column(Integer, nullable=False)
