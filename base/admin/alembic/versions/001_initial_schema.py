"""Initial schema — traces, model_costs, taxonomy_domains, cost_snapshots.

Revision ID: 001
Revises: None
Create Date: 2026-03-16
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    from sqlalchemy import inspect

    conn = op.get_bind()
    existing = set(inspect(conn).get_table_names())

    if "traces" in existing:
        return

    op.create_table(
        "traces",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("trace_id", sa.String(64), nullable=False),
        sa.Column("user_id", sa.String(256), nullable=False, server_default=""),
        sa.Column("query_snippet", sa.Text(), nullable=False, server_default=""),
        sa.Column("timestamp", sa.Float(), nullable=False),
        sa.Column("total_duration_ms", sa.Float(), nullable=False, server_default="0"),
        sa.Column("total_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("estimated_cost_usd", sa.Float(), nullable=False, server_default="0"),
        sa.Column("difficulty", sa.Float(), nullable=False, server_default="0"),
        sa.Column("task_type", sa.String(64), nullable=False, server_default=""),
        sa.Column("is_code_task", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("has_error", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("iteration_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("full_record", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("trace_id"),
    )
    op.create_index("ix_traces_trace_id", "traces", ["trace_id"])
    op.create_index("ix_traces_user_id", "traces", ["user_id"])
    op.create_index("ix_traces_task_type", "traces", ["task_type"])
    op.create_index("ix_traces_has_error", "traces", ["has_error"])
    op.create_index("ix_traces_timestamp_desc", "traces", [sa.text("timestamp DESC")])

    op.create_table(
        "model_costs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("role", sa.String(64), nullable=False),
        sa.Column("model", sa.String(256), nullable=False),
        sa.Column("profile", sa.String(64), nullable=False, server_default=""),
        sa.Column("source", sa.String(32), nullable=False, server_default="local"),
        sa.Column("input_per_million", sa.Float(), nullable=False, server_default="0"),
        sa.Column("output_per_million", sa.Float(), nullable=False, server_default="0"),
        sa.Column("monthly_fixed_cost", sa.Float(), nullable=False, server_default="0"),
        sa.Column("cost_formula", sa.Text(), nullable=False, server_default=""),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_model_costs_role_profile", "model_costs", ["role", "profile"])

    op.create_table(
        "taxonomy_domains",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("key", sa.String(128), nullable=False),
        sa.Column("path", sa.String(512), nullable=False, server_default=""),
        sa.Column("complexity", sa.Float(), nullable=False, server_default="0"),
        sa.Column("persona", sa.Text(), nullable=False, server_default=""),
        sa.Column("raw_config", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key"),
    )
    op.create_index("ix_taxonomy_domains_key", "taxonomy_domains", ["key"])

    op.create_table(
        "cost_snapshots",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("model", sa.String(256), nullable=False),
        sa.Column("role", sa.String(64), nullable=False, server_default=""),
        sa.Column("date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Float(), nullable=False, server_default="0"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_cost_snapshots_model_date", "cost_snapshots", ["model", "date"])


def downgrade() -> None:
    op.drop_table("cost_snapshots")
    op.drop_table("taxonomy_domains")
    op.drop_table("model_costs")
    op.drop_table("traces")
