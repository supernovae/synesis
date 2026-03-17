"""Add failures and knowledge_gaps tables.

Revision ID: 002
Revises: 001
Create Date: 2026-03-16

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "002"
down_revision: str | None = "001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    from sqlalchemy import inspect

    conn = op.get_bind()
    existing = set(inspect(conn).get_table_names())

    if "failures" not in existing:
        op.create_table(
            "failures",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("failure_id", sa.String(64), nullable=False),
            sa.Column("code", sa.Text(), nullable=False, server_default=""),
            sa.Column("error_output", sa.Text(), nullable=False, server_default=""),
            sa.Column("exit_code", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("error_type", sa.String(128), nullable=False, server_default=""),
            sa.Column("language", sa.String(32), nullable=False, server_default=""),
            sa.Column("task_description", sa.Text(), nullable=False, server_default=""),
            sa.Column("resolution", sa.Text(), nullable=False, server_default=""),
            sa.Column("timestamp", sa.Float(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("failure_id"),
        )
        op.create_index("ix_failures_failure_id", "failures", ["failure_id"])
        op.create_index("ix_failures_error_type", "failures", ["error_type"])
        op.create_index("ix_failures_language", "failures", ["language"])
        op.create_index("ix_failures_timestamp", "failures", [sa.text("timestamp DESC")])

    if "knowledge_gaps" not in existing:
        op.create_table(
            "knowledge_gaps",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("gap_id", sa.String(64), nullable=False),
            sa.Column("query", sa.Text(), nullable=False, server_default=""),
            sa.Column("task_description", sa.Text(), nullable=False, server_default=""),
            sa.Column("collections_queried", sa.Text(), nullable=False, server_default=""),
            sa.Column("max_score", sa.Float(), nullable=False, server_default="0"),
            sa.Column("platform_context", sa.String(64), nullable=False, server_default="generic"),
            sa.Column("language", sa.String(32), nullable=False, server_default=""),
            sa.Column("status", sa.String(20), nullable=False, server_default="open"),
            sa.Column("resolved_at", sa.Float(), nullable=False, server_default="0"),
            sa.Column("resolved_by", sa.String(128), nullable=False, server_default=""),
            sa.Column("resolution_note", sa.Text(), nullable=False, server_default=""),
            sa.Column("web_search_fallback", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("timestamp", sa.Float(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("gap_id"),
        )
        op.create_index("ix_knowledge_gaps_gap_id", "knowledge_gaps", ["gap_id"])
        op.create_index("ix_knowledge_gaps_status", "knowledge_gaps", ["status"])
        op.create_index("ix_knowledge_gaps_language", "knowledge_gaps", ["language"])
        op.create_index("ix_knowledge_gaps_timestamp", "knowledge_gaps", [sa.text("timestamp DESC")])


def downgrade() -> None:
    op.drop_table("knowledge_gaps")
    op.drop_table("failures")
