"""Per-user settings (model selection, pipeline defaults, free-form preferences).

Created one-to-one with each :class:`~app.models.user.User`; column defaults come
from the global :data:`~app.core.config.settings` so a freshly seeded row already
reflects the deployment's configured models.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.config import settings
from app.core.database import Base
from app.models.enums import AspectRatio, CaptionStyle, ExportFormat, ExportResolution


class UserSettings(Base):
    __tablename__ = "user_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True, nullable=False
    )

    default_model: Mapped[str] = mapped_column(
        String(128), default=settings.OLLAMA_DEFAULT_MODEL, nullable=False
    )
    ranking_model: Mapped[str] = mapped_column(
        String(128), default=settings.OLLAMA_RANKING_MODEL, nullable=False
    )
    vision_model: Mapped[str] = mapped_column(
        String(128), default=settings.OLLAMA_VISION_MODEL, nullable=False
    )
    whisper_model: Mapped[str] = mapped_column(
        String(128), default=settings.WHISPER_MODEL, nullable=False
    )

    target_clip_count: Mapped[int] = mapped_column(Integer, default=12, nullable=False)
    min_clip_seconds: Mapped[int] = mapped_column(Integer, default=8, nullable=False)
    max_clip_seconds: Mapped[int] = mapped_column(Integer, default=90, nullable=False)

    default_aspect_ratio: Mapped[str] = mapped_column(
        String(16), default=AspectRatio.VERTICAL.value, nullable=False
    )
    default_caption_style: Mapped[str] = mapped_column(
        String(32), default=CaptionStyle.HORMOZI.value, nullable=False
    )
    default_export_format: Mapped[str] = mapped_column(
        String(16), default=ExportFormat.MP4.value, nullable=False
    )
    default_export_resolution: Mapped[str] = mapped_column(
        String(16), default=ExportResolution.P1080.value, nullable=False
    )

    # Smart-reframe detection quality (both trade analysis speed for accuracy).
    reframe_hq_detection: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    reframe_face_zoom: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    preferences: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
