"""per-user smart-reframe detection toggles

Adds ``reframe_hq_detection`` (larger YOLO for person detection) and
``reframe_face_zoom`` (second-pass zoomed face scan) to ``user_settings``.
SQLite installs get these via ``app.db_init`` (additive column sync); this
migration is for the PostgreSQL backend (``alembic upgrade head``).

Revision ID: 0003_reframe_detection_settings
Revises: 0002_automation
Create Date: 2026-06-10 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_reframe_detection_settings"
down_revision: Union[str, None] = "0002_automation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user_settings",
        sa.Column("reframe_hq_detection", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "user_settings",
        sa.Column("reframe_face_zoom", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("user_settings", "reframe_face_zoom")
    op.drop_column("user_settings", "reframe_hq_detection")
