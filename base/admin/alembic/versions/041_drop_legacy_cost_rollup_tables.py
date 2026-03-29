"""Drop legacy cost rollup tables.

Removes usage_rollups, cost_rate_snapshots, and cost_snapshots. Cost data
is now computed at the source (planner-ts/yarn-ts via @synesis/telemetry)
and stored directly on traces and yarn_usage_log with pricing_source
provenance.  The periodic rollup job and rate snapshot capture are removed.

Revision ID: 041
Revises: 040
Create Date: 2026-03-29

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "041"
down_revision: str | None = "040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("usage_rollups")
    op.drop_table("cost_rate_snapshots")
    op.drop_table("cost_snapshots")


def downgrade() -> None:
    op.create_table(
        "cost_snapshots",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("model", sa.String(256), nullable=False),
        sa.Column("role", sa.String(64), nullable=False, server_default=""),
        sa.Column("date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("prompt_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("total_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Float, nullable=False, server_default="0"),
    )
    op.create_index("ix_cost_snapshots_model_date", "cost_snapshots", ["model", "date"])

    op.create_table(
        "cost_rate_snapshots",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("model", sa.String(256), nullable=False),
        sa.Column("role", sa.String(64), nullable=False, server_default=""),
        sa.Column("input_per_million", sa.Float, nullable=False, server_default="0"),
        sa.Column("output_per_million", sa.Float, nullable=False, server_default="0"),
        sa.Column("source", sa.String(32), nullable=False, server_default="manual"),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_cost_rate_snapshots_model_captured", "cost_rate_snapshots", ["model", "captured_at"])

    op.create_table(
        "usage_rollups",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("bucket", sa.DateTime(timezone=True), nullable=False),
        sa.Column("model", sa.String(256), nullable=False, server_default=""),
        sa.Column("role", sa.String(64), nullable=False, server_default=""),
        sa.Column("user_id", sa.String(256), nullable=False, server_default=""),
        sa.Column("org_id", sa.String(256), nullable=False, server_default=""),
        sa.Column("tenant_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("request_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("prompt_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("cached_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("total_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("estimated_cost_usd", sa.Float, nullable=False, server_default="0"),
        sa.Column("actual_cost_usd", sa.Float, nullable=False, server_default="0"),
        sa.Column("avg_duration_ms", sa.Float, nullable=False, server_default="0"),
        sa.Column("error_count", sa.Integer, nullable=False, server_default="0"),
    )
    op.create_index("ix_usage_rollups_bucket", "usage_rollups", ["bucket"])
    op.create_index("ix_usage_rollups_user_org", "usage_rollups", ["user_id", "org_id"])
    op.create_index("ix_usage_rollups_model_bucket", "usage_rollups", ["model", "bucket"])
