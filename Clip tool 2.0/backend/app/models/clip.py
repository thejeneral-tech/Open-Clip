"""Clip model — one generated short, with all AI enrichment + render artifacts."""
from __future__ import annotations

from typing import Any

from sqlalchemy import Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base
from app.models.enums import AspectRatio, CaptionStyle, JobStatus
from app.models.mixins import TimestampMixin


class Clip(TimestampMixin, Base):
    __tablename__ = "clips"

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[int] = mapped_column(
        ForeignKey("videos.id", ondelete="CASCADE"), index=True, nullable=False
    )
    order_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Source timing. start_time/end_time are ALWAYS absolute in the original video.
    start_time: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    end_time: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    duration: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    # Segment-download mode: this clip was rendered from a partial source file
    # (only the bytes for [source_offset, ...] were downloaded). When set, render
    # / export / reframe seek into ``source_segment_path`` at ``time - source_offset``.
    # None means the whole-video flow (use Video.storage_path, offset 0).
    source_segment_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    source_offset: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    # Copy / metadata.
    title: Mapped[str | None] = mapped_column(String(512), default=None)
    reasoning: Mapped[str | None] = mapped_column(Text, default=None)
    transcript_text: Mapped[str | None] = mapped_column(Text, default=None)
    description: Mapped[str | None] = mapped_column(Text, default=None)

    # Scoring.
    viral_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    ranking_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    score_breakdown: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    # Render config + AI outputs.
    aspect_ratio: Mapped[str] = mapped_column(
        String(16), default=AspectRatio.VERTICAL.value, nullable=False
    )
    caption_style: Mapped[str] = mapped_column(
        String(32), default=CaptionStyle.HORMOZI.value, nullable=False
    )
    title_variations: Mapped[list[Any]] = mapped_column(JSON, default=list, nullable=False)
    hashtags: Mapped[list[Any]] = mapped_column(JSON, default=list, nullable=False)
    keywords: Mapped[list[Any]] = mapped_column(JSON, default=list, nullable=False)
    broll_suggestions: Mapped[list[Any]] = mapped_column(JSON, default=list, nullable=False)
    captions: Mapped[list[Any]] = mapped_column(JSON, default=list, nullable=False)
    reframe_data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    # Render artifacts (storage keys).
    preview_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    thumbnail_path: Mapped[str | None] = mapped_column(String(1024), default=None)

    # Job lifecycle.
    status: Mapped[str] = mapped_column(String(32), default=JobStatus.PENDING.value, nullable=False)
    stage: Mapped[str | None] = mapped_column(String(64), default=None)
    progress: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    celery_task_id: Mapped[str | None] = mapped_column(String(64), default=None)
