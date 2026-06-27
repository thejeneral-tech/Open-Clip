"""Story Vault music presets

Adds the ``sv_music_presets`` table — a named, reusable music choice (a track +
the volume it plays at) the user picks in the Studio / Projects. SQLite installs
get this via ``app.db_init`` (create_all); this migration is for PostgreSQL.

Revision ID: 0016_sv_music_presets
Revises: 0015_sv_music
Create Date: 2026-06-26 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0016_sv_music_presets"
down_revision: Union[str, None] = "0015_sv_music"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sv_music_presets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "owner_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column(
            "music_id",
            sa.Integer(),
            sa.ForeignKey("sv_music.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column("volume", sa.Float(), nullable=False, server_default="0.18"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("sv_music_presets")
