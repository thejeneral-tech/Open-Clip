"""Story Vault models — the story-to-vertical-video factory.

Pipeline: discover stories (Reddit/paste) → score → script → SAPI narration →
word-timed captions → background-footage plan → preview → review → render →
export. Tables are prefixed ``sv_`` to keep the module self-contained next to
the clip-tool tables.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.enums import JobStatus, SvStoryStatus, SvVideoStatus
from app.models.mixins import CreatedAtMixin, TimestampMixin


class SvStory(TimestampMixin, Base):
    __tablename__ = "sv_stories"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )

    source: Mapped[str] = mapped_column(String(32), default="paste", nullable=False)  # reddit|paste|manual
    source_url: Mapped[str | None] = mapped_column(Text, default=None)
    external_id: Mapped[str | None] = mapped_column(String(128), default=None, index=True)
    community: Mapped[str | None] = mapped_column(String(128), default=None)
    author: Mapped[str | None] = mapped_column(String(128), default=None)

    title: Mapped[str] = mapped_column(String(512), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str | None] = mapped_column(String(64), default=None)

    upvotes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    num_comments: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)  # 0-100 composite
    score_breakdown: Mapped[dict | None] = mapped_column(JSON, default=None)
    analysis: Mapped[dict | None] = mapped_column(JSON, default=None)

    status: Mapped[str] = mapped_column(
        String(32), default=SvStoryStatus.NEW.value, nullable=False, index=True
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)

    # Optional: the Project (auto-workflow folder) this story was collected into.
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("sv_projects.id", ondelete="SET NULL"), default=None, index=True
    )

    scripts: Mapped[list[SvScript]] = relationship(
        "SvScript", back_populates="story", cascade="all, delete-orphan"
    )


class SvScript(CreatedAtMixin, Base):
    __tablename__ = "sv_scripts"

    id: Mapped[int] = mapped_column(primary_key=True)
    story_id: Mapped[int] = mapped_column(
        ForeignKey("sv_stories.id", ondelete="CASCADE"), index=True, nullable=False
    )

    full_text: Mapped[str] = mapped_column(Text, nullable=False)
    hook: Mapped[str | None] = mapped_column(Text, default=None)
    duration_target: Mapped[int] = mapped_column(Integer, default=60, nullable=False)  # seconds
    hook_style: Mapped[str] = mapped_column(String(32), default="conflict", nullable=False)
    narration_style: Mapped[str] = mapped_column(String(32), default="dramatic", nullable=False)
    drama_level: Mapped[int] = mapped_column(Integer, default=3, nullable=False)  # 1-5
    word_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    generator: Mapped[str | None] = mapped_column(String(128), default=None)  # model name | heuristic

    story: Mapped[SvStory] = relationship("SvStory", back_populates="scripts")


class SvBackground(TimestampMixin, Base):
    __tablename__ = "sv_backgrounds"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )

    original_filename: Mapped[str | None] = mapped_column(String(512), default=None)
    storage_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    thumbnail_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    category: Mapped[str | None] = mapped_column(String(64), default=None)

    duration_seconds: Mapped[float | None] = mapped_column(Float, default=None)
    width: Mapped[int | None] = mapped_column(Integer, default=None)
    height: Mapped[int | None] = mapped_column(Integer, default=None)
    fps: Mapped[float | None] = mapped_column(Float, default=None)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, default=None)

    status: Mapped[str] = mapped_column(String(32), default=JobStatus.PENDING.value, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, default=None)

    segments: Mapped[list[SvSegment]] = relationship(
        "SvSegment", back_populates="background", cascade="all, delete-orphan"
    )


class SvSegment(CreatedAtMixin, Base):
    __tablename__ = "sv_segments"

    id: Mapped[int] = mapped_column(primary_key=True)
    background_id: Mapped[int] = mapped_column(
        ForeignKey("sv_backgrounds.id", ondelete="CASCADE"), index=True, nullable=False
    )
    start_sec: Mapped[float] = mapped_column(Float, nullable=False)
    end_sec: Mapped[float] = mapped_column(Float, nullable=False)
    times_used: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    background: Mapped[SvBackground] = relationship("SvBackground", back_populates="segments")


class SvVideo(TimestampMixin, Base):
    __tablename__ = "sv_videos"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    story_id: Mapped[int] = mapped_column(
        ForeignKey("sv_stories.id", ondelete="CASCADE"), index=True, nullable=False
    )
    script_id: Mapped[int | None] = mapped_column(
        ForeignKey("sv_scripts.id", ondelete="SET NULL"), default=None
    )
    # Optional: the Project (auto-workflow folder) this video belongs to. Drives
    # auto-publish chaining in the worker when the project has it enabled.
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("sv_projects.id", ondelete="SET NULL"), default=None, index=True
    )

    title: Mapped[str | None] = mapped_column(String(512), default=None)

    # Creation options.
    duration_target: Mapped[int] = mapped_column(Integer, default=60, nullable=False)
    hook_style: Mapped[str] = mapped_column(String(32), default="conflict", nullable=False)
    narration_style: Mapped[str] = mapped_column(String(32), default="dramatic", nullable=False)
    drama_level: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    voice: Mapped[str | None] = mapped_column(String(128), default=None)  # SAPI voice name (or "fish-clone")
    speed: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)  # 0.7-1.4
    # Snapshot at queue time of the resolved narration engine + its inputs, so the
    # worker renders with the voice the user picked even if the preset is later
    # edited/deleted. None → plain Windows SAPI using ``voice`` (the default path).
    # For a cloned voice: {"engine": "fish-clone", "ref_key", "prompt_text", "name"}.
    voice_config: Mapped[dict | None] = mapped_column(JSON, default=None)
    caption_style: Mapped[str] = mapped_column(String(32), default="hormozi", nullable=False)
    # Snapshot of the selected preset's caption config (style/size/colours/
    # position) at queue time, so the burned-in captions match the preset even if
    # the template is later edited or deleted. None → use caption_style alone.
    caption_config: Mapped[dict | None] = mapped_column(JSON, default=None)
    # Full snapshot of the selected template's render config (canvas, topicCard,
    # authorIntro, captions, …) at queue time. Drives the burned-in Reddit topic
    # card and "Posted by u/…" author intro. None → no intro overlays.
    template_config: Mapped[dict | None] = mapped_column(JSON, default=None)
    background_category: Mapped[str | None] = mapped_column(String(64), default=None)
    # Optional: pin the gameplay/footage to one specific background. When set it
    # overrides background_category (segments are drawn only from this footage).
    background_id: Mapped[int | None] = mapped_column(
        ForeignKey("sv_backgrounds.id", ondelete="SET NULL"), default=None, index=True
    )
    script_engine: Mapped[str] = mapped_column(String(16), default="auto", nullable=False)  # auto|ai|heuristic

    # Pipeline artifacts (storage keys).
    narration_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    narration_duration: Mapped[float | None] = mapped_column(Float, default=None)
    word_timings: Mapped[list | None] = mapped_column(JSON, default=None)
    # Intro narration plan: the on-screen windows for the title (topic card) and
    # author intro, plus when the body narration starts — so the final render
    # rebuilds the overlays with the exact timing the captions were synced to.
    # {"card": [start, end] | None, "author": [start, end] | None, "body_start": float}.
    # None → no intro sequence (body-only narration, captions from the top).
    intro_plan: Mapped[dict | None] = mapped_column(JSON, default=None)
    captions_ass_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    captions_srt_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    segment_plan: Mapped[list | None] = mapped_column(JSON, default=None)
    preview_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    render_path: Mapped[str | None] = mapped_column(String(1024), default=None)

    # Job lifecycle.
    status: Mapped[str] = mapped_column(
        String(32), default=SvVideoStatus.QUEUED.value, nullable=False, index=True
    )
    stage: Mapped[str | None] = mapped_column(String(64), default=None)
    progress: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    reject_reason: Mapped[str | None] = mapped_column(Text, default=None)
    celery_task_id: Mapped[str | None] = mapped_column(String(64), default=None)
    # Cooperative-cancel flag, raised by the Stop / Clear-queue endpoints. The
    # generation worker reads it at every pipeline checkpoint (and on each render
    # progress tick) and aborts, parking the video in CANCELLED. A still-queued
    # task is cancelled by the endpoint directly, so this also guards the case of
    # a worker that picks the job up after the request.
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    story: Mapped[SvStory] = relationship("SvStory")
    script: Mapped[SvScript | None] = relationship("SvScript")


class SvVoicePreset(CreatedAtMixin, Base):
    __tablename__ = "sv_voice_presets"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    voice: Mapped[str] = mapped_column(String(128), nullable=False)  # SAPI voice name (or "fish-clone")
    speed: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)  # 0.7-1.4
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # "sapi" for system voices, "fish-clone" for voices imported/cloned via Fish Speech.
    engine: Mapped[str] = mapped_column(String(32), default="sapi", nullable=False)
    # Pre-rendered audition clip (media key URL). Set for imported clone presets so
    # Preview plays the saved sample instead of re-synthesizing.
    preview_url: Mapped[str | None] = mapped_column(String(1024), default=None)
    # Cloning reference for fish-clone presets: the storage key of the voice clip
    # the engine matches against, plus the exact words spoken in it. Both are
    # required to actually clone (the s2 engine needs the reference text); without
    # them a fish preset can only do generic, un-cloned synthesis. None for SAPI.
    ref_key: Mapped[str | None] = mapped_column(String(1024), default=None)
    prompt_text: Mapped[str | None] = mapped_column(Text, default=None)

    # Built-in presets (the bundled TikTok clone voices) are seeded per user from
    # ``voice_presets_data.BUILTIN_VOICE_PRESETS`` and carry a stable
    # ``preset_key`` so re-seeding is idempotent and a soft-deleted built-in
    # (``deleted_at`` set) is never resurrected — mirroring ``SvTemplate``.
    preset_key: Mapped[str | None] = mapped_column(String(64), default=None, index=True)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class SvTemplate(TimestampMixin, Base):
    """A video template (preset) — the full set of render knobs that drives a
    new story video: canvas, topic-card, author-intro, captions, audio, etc.

    Built-ins are seeded per user from ``templates_data.BUILTIN_TEMPLATES`` and
    carry a stable ``template_key`` so re-seeding is idempotent and a soft-
    deleted built-in (``deleted_at`` set) is never resurrected. Exactly one
    template per user is the active default that drives every new video.
    """

    __tablename__ = "sv_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )

    template_key: Mapped[str | None] = mapped_column(String(64), default=None, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    data: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)  # full config blob
    builtin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class SvPublishJob(CreatedAtMixin, Base):
    """One upload of a story video to one connected channel.

    Field names (title/description/payload) mirror ``PublishingJob`` so the
    platform connectors' ``publish(job, …)`` accept either model unchanged.
    """

    __tablename__ = "sv_publish_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    sv_video_id: Mapped[int] = mapped_column(
        ForeignKey("sv_videos.id", ondelete="CASCADE"), index=True, nullable=False
    )
    connector_id: Mapped[int | None] = mapped_column(
        ForeignKey("publishing_connectors.id", ondelete="SET NULL"), index=True, default=None
    )

    platform: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    title: Mapped[str | None] = mapped_column(Text, default=None)
    description: Mapped[str | None] = mapped_column(Text, default=None)
    payload: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)

    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    external_post_id: Mapped[str | None] = mapped_column(String(255), default=None)
    external_url: Mapped[str | None] = mapped_column(Text, default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)

    video: Mapped[SvVideo] = relationship("SvVideo")


class SvExport(CreatedAtMixin, Base):
    __tablename__ = "sv_exports"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    sv_video_id: Mapped[int] = mapped_column(
        ForeignKey("sv_videos.id", ondelete="CASCADE"), index=True, nullable=False
    )

    platform: Mapped[str] = mapped_column(String(32), default="tiktok", nullable=False)
    title: Mapped[str | None] = mapped_column(String(512), default=None)
    storage_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, default=None)
    duration_seconds: Mapped[float | None] = mapped_column(Float, default=None)
    width: Mapped[int | None] = mapped_column(Integer, default=None)
    height: Mapped[int | None] = mapped_column(Integer, default=None)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)

    video: Mapped[SvVideo] = relationship("SvVideo")


class SvProject(TimestampMixin, Base):
    """An 'auto-workflow' folder that makes a content series flow smoothly.

    A project saves one reusable recipe — story source, background gameplay,
    voice, caption style, render + publishing settings — and groups the stories
    and videos produced for that series. Running it drives the whole pipeline
    (collect stories → script → narrate → caption → render → queue publishing)
    from one click, with each new video inheriting the project's settings.

    The full recipe lives in ``settings`` (see
    ``schemas.storyvault.SvProjectSettings``) so the knobs can grow without a
    migration on a self-hosted SQLite database.
    """

    __tablename__ = "sv_projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, default=None)
    settings: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
