"""Add actual_cost_usd to traces, cost_rate_snapshots table, fallbacks to model_deployments.

Revision ID: 010
Revises: 009
Create Date: 2026-03-18

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "010"
down_revision: str | None = "009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)

    # -- traces.actual_cost_usd ------------------------------------------------
    trace_cols = {c["name"] for c in inspector.get_columns("traces")}
    if "actual_cost_usd" not in trace_cols:
        op.add_column(
            "traces",
            sa.Column("actual_cost_usd", sa.Float(), nullable=False, server_default="0"),
        )

    # -- model_deployments.fallbacks -------------------------------------------
    md_cols = {c["name"] for c in inspector.get_columns("model_deployments")}
    if "fallbacks" not in md_cols:
        op.add_column(
            "model_deployments",
            sa.Column("fallbacks", sa.dialects.postgresql.JSONB(), nullable=True),
        )

    # -- cost_rate_snapshots table --------------------------------------------
    if "cost_rate_snapshots" not in inspector.get_table_names():
        op.create_table(
            "cost_rate_snapshots",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("model", sa.String(256), nullable=False),
            sa.Column("role", sa.String(64), nullable=False, server_default=""),
            sa.Column("input_per_million", sa.Float(), nullable=False, server_default="0"),
            sa.Column("output_per_million", sa.Float(), nullable=False, server_default="0"),
            sa.Column("source", sa.String(32), nullable=False, server_default="manual"),
            sa.Column(
                "captured_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )
        op.create_index(
            "ix_cost_rate_snapshots_model_captured",
            "cost_rate_snapshots",
            ["model", "captured_at"],
        )


def downgrade() -> None:
    op.drop_index("ix_cost_rate_snapshots_model_captured", table_name="cost_rate_snapshots")
    op.drop_table("cost_rate_snapshots")
    op.drop_column("model_deployments", "fallbacks")
    op.drop_column("traces", "actual_cost_usd")
