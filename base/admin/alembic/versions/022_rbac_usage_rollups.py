"""RBAC hardening: PAT org_id column + usage_rollups table.

Revision ID: 022_rbac_usage_rollups
Revises: 021_ingestion_staged
Create Date: 2026-03-21
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "022_rbac_usage_rollups"
down_revision: str | None = "021_ingestion_staged"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # -- PAT org_id for RBAC scoping on tokens --
    op.add_column(
        "personal_access_tokens",
        sa.Column("org_id", sa.String(), nullable=False, server_default=""),
    )

    # -- Pre-aggregated usage rollups for fast dashboard charts --
    op.create_table(
        "usage_rollups",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("bucket", sa.DateTime(timezone=True), nullable=False),
        sa.Column("model", sa.String(256), nullable=False, server_default=""),
        sa.Column("role", sa.String(64), nullable=False, server_default=""),
        sa.Column("user_id", sa.String(256), nullable=False, server_default=""),
        sa.Column("org_id", sa.String(256), nullable=False, server_default=""),
        sa.Column("request_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cached_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("estimated_cost_usd", sa.Float(), nullable=False, server_default="0"),
        sa.Column("actual_cost_usd", sa.Float(), nullable=False, server_default="0"),
        sa.Column("avg_duration_ms", sa.Float(), nullable=False, server_default="0"),
        sa.Column("error_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_usage_rollups_bucket", "usage_rollups", ["bucket"])
    op.create_index("ix_usage_rollups_user_org", "usage_rollups", ["user_id", "org_id"])
    op.create_index("ix_usage_rollups_model_bucket", "usage_rollups", ["model", "bucket"])


def downgrade() -> None:
    op.drop_table("usage_rollups")
    op.drop_column("personal_access_tokens", "org_id")
