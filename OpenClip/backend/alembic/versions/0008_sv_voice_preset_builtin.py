"""Story Vault voice-preset built-ins

Promote the bundled TikTok clone voices to per-user built-ins. Adds the columns
the seeder needs: a stable ``preset_key`` (idempotent re-seeding), a ``builtin``
flag, and ``deleted_at`` so a removed built-in stays gone. SQLite installs get
these via ``app.db_init`` (create_all + additive column sync); this migration is
for PostgreSQL.

Revision ID: 0008_sv_voice_preset_builtin
Revises: 0007_sv_templates
Create Date: 2026-06-12 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008_sv_voice_preset_builtin"
down_revision: Union[str, None] = "0007_sv_templates"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "sv_voice_presets",
        sa.Column("preset_key", sa.String(64), nullable=True),
    )
    op.add_column(
        "sv_voice_presets",
        sa.Column("builtin", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "sv_voice_presets",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_sv_voice_presets_preset_key", "sv_voice_presets", ["preset_key"]
    )


def downgrade() -> None:
    op.drop_index("ix_sv_voice_presets_preset_key", table_name="sv_voice_presets")
    op.drop_column("sv_voice_presets", "deleted_at")
    op.drop_column("sv_voice_presets", "builtin")
    op.drop_column("sv_voice_presets", "preset_key")
