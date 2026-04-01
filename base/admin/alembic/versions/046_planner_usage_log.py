"""Planner usage log — metering decoupled from traces.

Revision ID: 046
Revises: 045
Create Date: 2026-04-01
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "046"
down_revision: str | None = "045"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "planner_usage_log",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("request_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=256), nullable=False),
        sa.Column("org_id", sa.String(length=256), nullable=False, server_default=""),
        sa.Column("tenant_id", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("conversation_id", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("model", sa.String(length=256), nullable=False, server_default=""),
        sa.Column("tokens_in", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tokens_out", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tokens_cached", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("estimated_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("actual_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("pricing_source", sa.String(length=32), nullable=False, server_default="unknown"),
        sa.Column("latency_ms", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("has_error", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_planner_usage_user", "planner_usage_log", ["user_id"])
    op.create_index("ix_planner_usage_org", "planner_usage_log", ["org_id"])
    op.create_index("ix_planner_usage_tenant", "planner_usage_log", ["tenant_id"])
    op.create_index("ix_planner_usage_created", "planner_usage_log", ["created_at"])
    op.create_index("ix_planner_usage_request_id_unique", "planner_usage_log", ["request_id"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_planner_usage_request_id_unique", table_name="planner_usage_log")
    op.drop_index("ix_planner_usage_created", table_name="planner_usage_log")
    op.drop_index("ix_planner_usage_tenant", table_name="planner_usage_log")
    op.drop_index("ix_planner_usage_org", table_name="planner_usage_log")
    op.drop_index("ix_planner_usage_user", table_name="planner_usage_log")
    op.drop_table("planner_usage_log")
