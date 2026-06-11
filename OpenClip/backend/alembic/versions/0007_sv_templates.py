"""Story Vault templates (presets)

Per-user video templates that drive every new story video. Built-ins are seeded
lazily by the API (idempotent by ``template_key``); custom templates and the
active default persist here. SQLite installs get the table via ``app.db_init``
(create_all); this migration is for PostgreSQL.

Revision ID: 0007_sv_templates
Revises: 0006_sv_publish_jobs
Create Date: 2026-06-11 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007_sv_templates"
down_revision: Union[str, None] = "0006_sv_publish_jobs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sv_templates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("template_key", sa.String(64), nullable=True, index=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("builtin", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("sv_templates")
