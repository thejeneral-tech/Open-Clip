"""Whop Studio project link

Adds ``whop_campaigns.studio_project_id`` — a nullable FK to ``projects`` that
links a campaign to its auto-provisioned OpenClip Project (the Studio clip
workspace). SQLite installs get this column via ``app.db_init`` (create_all);
this migration is for PostgreSQL.

Revision ID: 0018_whop_studio_project
Revises: 0017_whop
Create Date: 2026-07-04 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0018_whop_studio_project"
down_revision: Union[str, None] = "0017_whop"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "whop_campaigns",
        sa.Column(
            "studio_project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_whop_campaigns_studio_project_id", "whop_campaigns", ["studio_project_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_whop_campaigns_studio_project_id", table_name="whop_campaigns")
    op.drop_column("whop_campaigns", "studio_project_id")
