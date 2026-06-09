"""Transcript model — one (Whisper) transcript per video, segments stored as JSON."""
from __future__ import annotations

from typing import Any

from sqlalchemy import Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base
from app.models.mixins import CreatedAtMixin


class Transcript(CreatedAtMixin, Base):
    __tablename__ = "transcripts"

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[int] = mapped_column(
        ForeignKey("videos.id", ondelete="CASCADE"), unique=True, index=True, nullable=False
    )

    language: Mapped[str | None] = mapped_column(String(16), default=None)
    engine: Mapped[str | None] = mapped_column(String(64), default=None)
    model: Mapped[str | None] = mapped_column(String(128), default=None)
    full_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    word_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    num_speakers: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    duration_seconds: Mapped[float | None] = mapped_column(Float, default=None)
    # [{id, start, end, text, speaker, words: [{word, start, end, probability}]}]
    segments: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
