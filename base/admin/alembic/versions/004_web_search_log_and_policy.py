"""Add web_search_log and web_url_policy tables for HITL web search review.

Revision ID: 004
Revises: 003
Create Date: 2026-03-17

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "004"
down_revision: str | None = "003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    from sqlalchemy import inspect

    conn = op.get_bind()
    existing = set(inspect(conn).get_table_names())

    if "web_search_log" not in existing:
        op.create_table(
            "web_search_log",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("timestamp", sa.Float(), nullable=False),
            sa.Column("run_id", sa.String(64), nullable=False, server_default=""),
            sa.Column("query", sa.Text(), nullable=False, server_default=""),
            sa.Column("source_id", sa.String(64), nullable=False, server_default=""),
            sa.Column("profile", sa.String(32), nullable=False, server_default=""),
            sa.Column("url", sa.Text(), nullable=False, server_default=""),
            sa.Column("domain", sa.String(256), nullable=False, server_default=""),
            sa.Column("title", sa.Text(), nullable=False, server_default=""),
            sa.Column("snippet", sa.Text(), nullable=False, server_default=""),
            sa.Column("score", sa.Float(), nullable=False, server_default="0"),
            sa.Column("latency_ms", sa.Float(), nullable=False, server_default="0"),
            sa.Column("outcome", sa.String(16), nullable=False, server_default="success"),
            sa.Column("engine", sa.String(64), nullable=False, server_default=""),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_web_search_log_run_id", "web_search_log", ["run_id"])
        op.create_index("ix_web_search_log_domain", "web_search_log", ["domain"])
        op.create_index(
            "ix_web_search_log_timestamp",
            "web_search_log",
            [sa.text("timestamp DESC")],
        )
        op.create_index("ix_web_search_log_outcome", "web_search_log", ["outcome"])

    if "web_url_policy" not in existing:
        op.create_table(
            "web_url_policy",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("url_pattern", sa.Text(), nullable=False),
            sa.Column("policy", sa.String(16), nullable=False, server_default="allow"),
            sa.Column("reason", sa.Text(), nullable=False, server_default=""),
            sa.Column("reviewed_by", sa.String(128), nullable=False, server_default=""),
            sa.Column("reviewed_at", sa.Float(), nullable=False, server_default="0"),
            sa.Column("boost_factor", sa.Float(), nullable=False, server_default="1.0"),
            sa.Column("auto_ingest", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_web_url_policy_policy", "web_url_policy", ["policy"])


def downgrade() -> None:
    op.drop_table("web_url_policy")
    op.drop_table("web_search_log")
