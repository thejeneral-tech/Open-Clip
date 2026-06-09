"""AIAnalysis model — an audit trail of every AI step run on a video/clip.

One row per model call (ranking, titles, description, b-roll, caption emphasis…),
capturing the model used, its raw structured result, and how long it took. Useful
for debugging and for the self-improvement loop.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base
from app.models.mixins import CreatedAtMixin


class AIAnalysis(CreatedAtMixin, Base):
    __tablename__ = "ai_analyses"

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[int] = mapped_column(
        ForeignKey("videos.id", ondelete="CASCADE"), index=True, nullable=False
    )
    clip_id: Mapped[int | None] = mapped_column(
        ForeignKey("clips.id", ondelete="CASCADE"), index=True, default=None
    )

    analysis_type: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str | None] = mapped_column(String(128), default=None)
    result: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    duration_ms: Mapped[int | None] = mapped_column(Integer, default=None)
