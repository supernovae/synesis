"""Add model_deployments, quality_snapshots, and benchmark_results tables.

Revision ID: 005
Revises: 004
Create Date: 2026-03-17

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "005"
down_revision: str | None = "004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    from sqlalchemy import inspect

    conn = op.get_bind()
    existing = set(inspect(conn).get_table_names())

    if "model_deployments" not in existing:
        op.create_table(
            "model_deployments",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("environment", sa.String(32), nullable=False),
            sa.Column("role", sa.String(64), nullable=False),
            sa.Column("model", sa.String(256), nullable=False),
            sa.Column("endpoint", sa.Text(), nullable=False, server_default=""),
            sa.Column("served_name", sa.String(128), nullable=False, server_default=""),
            sa.Column("status", sa.String(16), nullable=False, server_default="unknown"),
            sa.Column("profile", sa.String(64), nullable=False, server_default=""),
            sa.Column("gpu_config", sa.JSON(), nullable=True),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "ix_model_deployments_env_role",
            "model_deployments",
            ["environment", "role"],
            unique=True,
        )

    if "quality_snapshots" not in existing:
        op.create_table(
            "quality_snapshots",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("domain", sa.String(128), nullable=False),
            sa.Column("health", sa.String(16), nullable=False, server_default="unknown"),
            sa.Column("chunk_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("doc_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("freshness_pct", sa.Float(), nullable=False, server_default="0"),
            sa.Column("authority_mix", sa.JSON(), nullable=True),
            sa.Column("dead_weight_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column(
                "scored_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_quality_snapshots_domain", "quality_snapshots", ["domain"])
        op.create_index(
            "ix_quality_snapshots_scored_at",
            "quality_snapshots",
            [sa.text("scored_at DESC")],
        )

    if "benchmark_results" not in existing:
        op.create_table(
            "benchmark_results",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("run_id", sa.String(64), nullable=False),
            sa.Column("benchmark_type", sa.String(64), nullable=False, server_default="hybrid"),
            sa.Column("metrics", sa.JSON(), nullable=True),
            sa.Column("per_query", sa.JSON(), nullable=True),
            sa.Column("triggered_by", sa.String(128), nullable=False, server_default=""),
            sa.Column(
                "started_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_benchmark_results_run_id", "benchmark_results", ["run_id"])
        op.create_index(
            "ix_benchmark_results_started_at",
            "benchmark_results",
            [sa.text("started_at DESC")],
        )


def downgrade() -> None:
    op.drop_table("benchmark_results")
    op.drop_table("quality_snapshots")
    op.drop_table("model_deployments")
