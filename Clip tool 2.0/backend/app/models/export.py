"""Export model — a rendered, downloadable variant of a clip."""
from __future__ import annotations

from sqlalchemy import BigInteger, Boolean, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.enums import AspectRatio, ExportFormat, ExportResolution, JobStatus
from app.models.mixins import CreatedAtMixin


class Export(CreatedAtMixin, Base):
    __tablename__ = "exports"

    id: Mapped[int] = mapped_column(primary_key=True)
    clip_id: Mapped[int] = mapped_column(
        ForeignKey("clips.id", ondelete="CASCADE"), index=True, nullable=False
    )

    format: Mapped[str] = mapped_column(String(16), default=ExportFormat.MP4.value, nullable=False)
    resolution: Mapped[str] = mapped_column(
        String(16), default=ExportResolution.P1080.value, nullable=False
    )
    aspect_ratio: Mapped[str] = mapped_column(
        String(16), default=AspectRatio.VERTICAL.value, nullable=False
    )
    burn_captions: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    hwaccel: Mapped[str | None] = mapped_column(String(16), default=None)

    storage_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, default=None)
    width: Mapped[int | None] = mapped_column(Integer, default=None)
    height: Mapped[int | None] = mapped_column(Integer, default=None)
    duration_seconds: Mapped[float | None] = mapped_column(Float, default=None)

    status: Mapped[str] = mapped_column(String(32), default=JobStatus.QUEUED.value, nullable=False)
    stage: Mapped[str | None] = mapped_column(String(64), default=None)
    progress: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    celery_task_id: Mapped[str | None] = mapped_column(String(64), default=None)
