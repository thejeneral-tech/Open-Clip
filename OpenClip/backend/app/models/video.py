"""Video model — an ingested source video that the pipeline clips."""
from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.enums import JobStatus, VideoSource
from app.models.mixins import TimestampMixin

if TYPE_CHECKING:
    from app.models.project import Project


class Video(TimestampMixin, Base):
    __tablename__ = "videos"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False
    )

    source: Mapped[str] = mapped_column(String(32), default=VideoSource.UPLOAD.value, nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text, default=None)
    original_filename: Mapped[str | None] = mapped_column(String(512), default=None)
    title: Mapped[str | None] = mapped_column(String(512), default=None)
    language: Mapped[str | None] = mapped_column(String(16), default=None)

    # On-disk locations (storage backend keys).
    storage_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    thumbnail_path: Mapped[str | None] = mapped_column(String(1024), default=None)

    # Probed media properties.
    duration_seconds: Mapped[float | None] = mapped_column(Float, default=None)
    width: Mapped[int | None] = mapped_column(Integer, default=None)
    height: Mapped[int | None] = mapped_column(Integer, default=None)
    fps: Mapped[float | None] = mapped_column(Float, default=None)
    codec: Mapped[str | None] = mapped_column(String(64), default=None)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, default=None)

    # Job lifecycle.
    status: Mapped[str] = mapped_column(String(32), default=JobStatus.PENDING.value, nullable=False)
    stage: Mapped[str | None] = mapped_column(String(64), default=None)
    progress: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    celery_task_id: Mapped[str | None] = mapped_column(String(64), default=None)

    project: Mapped[Project] = relationship("Project")
