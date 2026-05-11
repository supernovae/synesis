"""Add content pack catalog config and install jobs.

Revision ID: 059_content_pack_installs
Revises: 058_public_gen_params
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "059_content_pack_installs"
down_revision: str | None = "058_public_gen_params"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "content_pack_config",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("catalog_url", sa.Text(), nullable=False, server_default=""),
        sa.Column("updated_by", sa.String(length=256), nullable=False, server_default=""),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "content_pack_install_jobs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("pack_id", sa.String(length=96), nullable=False),
        sa.Column("pack_version", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("catalog_url", sa.Text(), nullable=False, server_default=""),
        sa.Column("download_url", sa.Text(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("replace_existing", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("requested_by", sa.String(length=256), nullable=False, server_default=""),
        sa.Column("claimed_by", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=False, server_default=""),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_content_pack_install_jobs_status",
        "content_pack_install_jobs",
        ["status"],
        unique=False,
    )
    op.create_index(
        "ix_content_pack_install_jobs_pack",
        "content_pack_install_jobs",
        ["pack_id", "pack_version"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_content_pack_install_jobs_pack", table_name="content_pack_install_jobs")
    op.drop_index("ix_content_pack_install_jobs_status", table_name="content_pack_install_jobs")
    op.drop_table("content_pack_install_jobs")
    op.drop_table("content_pack_config")
