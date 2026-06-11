"""Story Vault voice presets

Saved SAPI voice + speed combos with a per-user default, used by the Voice Lab
and applied when a video is created with voice = Auto. SQLite installs get the
table via ``app.db_init`` (create_all); this migration is for PostgreSQL.

Revision ID: 0005_sv_voice_presets
Revises: 0004_storyvault
Create Date: 2026-06-11 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005_sv_voice_presets"
down_revision: Union[str, None] = "0004_storyvault"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sv_voice_presets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("voice", sa.String(128), nullable=False),
        sa.Column("speed", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("sv_voice_presets")
