"""Story Vault publish jobs

One row per upload of a story video to one connected channel. SQLite installs
get the table via ``app.db_init`` (create_all); this migration is for PostgreSQL.

Revision ID: 0006_sv_publish_jobs
Revises: 0005_sv_voice_presets
Create Date: 2026-06-11 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006_sv_publish_jobs"
down_revision: Union[str, None] = "0005_sv_voice_presets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sv_publish_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("sv_video_id", sa.Integer(), sa.ForeignKey("sv_videos.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("connector_id", sa.Integer(), sa.ForeignKey("publishing_connectors.id", ondelete="SET NULL"), index=True),
        sa.Column("platform", sa.String(32), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("title", sa.Text()),
        sa.Column("description", sa.Text()),
        sa.Column("payload", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("external_post_id", sa.String(255)),
        sa.Column("external_url", sa.Text()),
        sa.Column("error", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("sv_publish_jobs")
