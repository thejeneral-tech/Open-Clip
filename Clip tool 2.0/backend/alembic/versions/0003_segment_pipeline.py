"""segment-download pipeline

Adds the columns that support metadata-first YouTube ingestion: per-clip partial
source segments (clips.source_segment_path / source_offset) and the per-video
analytics bundle (videos.youtube_meta). SQLite installs get these via
``app.db_init`` (_ensure_columns); this migration is for the PostgreSQL backend
(``alembic upgrade head``).

Revision ID: 0003_segment_pipeline
Revises: 0002_automation
Create Date: 2026-06-08 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003_segment_pipeline"
down_revision: Union[str, None] = "0002_automation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("clips", sa.Column("source_segment_path", sa.String(1024), nullable=True))
    op.add_column(
        "clips",
        sa.Column("source_offset", sa.Float(), nullable=False, server_default="0"),
    )
    op.add_column(
        "videos",
        sa.Column("youtube_meta", postgresql.JSONB(), nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("videos", "youtube_meta")
    op.drop_column("clips", "source_offset")
    op.drop_column("clips", "source_segment_path")
