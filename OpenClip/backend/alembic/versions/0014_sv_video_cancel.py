"""Story Vault video cancellation

Adds ``sv_videos.cancel_requested`` — the cooperative-cancel flag the Stop and
Clear-queue studio controls raise. The generation worker checks it at each
pipeline checkpoint (and on every render progress tick) and aborts, parking the
video in the new ``cancelled`` status. SQLite installs get the column via
``app.db_init`` (additive column sync); this migration is for PostgreSQL.

Revision ID: 0014_sv_video_cancel
Revises: 0013_sv_voice_clone_routing
Create Date: 2026-06-15 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0014_sv_video_cancel"
down_revision: Union[str, None] = "0013_sv_voice_clone_routing"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "sv_videos",
        sa.Column(
            "cancel_requested",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("sv_videos", "cancel_requested")
