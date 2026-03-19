"""Add yarn_sessions and yarn_usage_log tables for the Yarn agent runtime.

Revision ID: 012
Revises: 011
Create Date: 2026-03-19

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "012"
down_revision: str | None = "011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "yarn_sessions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("session_key", sa.String(256), nullable=False),
        sa.Column("user_id", sa.String(256), nullable=False),
        sa.Column("username", sa.String(256), nullable=False, server_default=""),
        sa.Column("role", sa.String(32), nullable=False, server_default="user"),
        sa.Column("conversation_id", sa.String(256), nullable=False, server_default=""),
        sa.Column("provider", sa.String(64), nullable=False, server_default="deepinfra"),
        sa.Column("model", sa.String(256), nullable=False, server_default=""),
        sa.Column("total_tokens_in", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_tokens_out", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_tokens_cached", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("request_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("escalation_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "last_active_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_yarn_sessions_key", "yarn_sessions", ["session_key"], unique=True)
    op.create_index("ix_yarn_sessions_user_id", "yarn_sessions", ["user_id"])
    op.create_index("ix_yarn_sessions_last_active", "yarn_sessions", ["last_active_at"])

    op.create_table(
        "yarn_usage_log",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("session_key", sa.String(256), nullable=False),
        sa.Column("request_id", sa.String(64), nullable=False),
        sa.Column("user_id", sa.String(256), nullable=False),
        sa.Column("provider", sa.String(64), nullable=False),
        sa.Column("model", sa.String(256), nullable=False),
        sa.Column("tokens_in", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tokens_out", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tokens_cached", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("latency_ms", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("cost_usd", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("escalated", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("tool_calls_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("finish_reason", sa.String(32), nullable=False, server_default=""),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_yarn_usage_session", "yarn_usage_log", ["session_key"])
    op.create_index("ix_yarn_usage_user", "yarn_usage_log", ["user_id"])
    op.create_index("ix_yarn_usage_created", "yarn_usage_log", ["created_at"])
    op.create_index("ix_yarn_usage_provider", "yarn_usage_log", ["provider"])


def downgrade() -> None:
    op.drop_index("ix_yarn_usage_provider", table_name="yarn_usage_log")
    op.drop_index("ix_yarn_usage_created", table_name="yarn_usage_log")
    op.drop_index("ix_yarn_usage_user", table_name="yarn_usage_log")
    op.drop_index("ix_yarn_usage_session", table_name="yarn_usage_log")
    op.drop_table("yarn_usage_log")

    op.drop_index("ix_yarn_sessions_last_active", table_name="yarn_sessions")
    op.drop_index("ix_yarn_sessions_user_id", table_name="yarn_sessions")
    op.drop_index("ix_yarn_sessions_key", table_name="yarn_sessions")
    op.drop_table("yarn_sessions")
