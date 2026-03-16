"""Add discovered_conflict_groups table for HITL anchor resolution.

Revision ID: 003
Revises: 002
Create Date: 2026-03-16

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    from sqlalchemy import inspect

    conn = op.get_bind()
    existing = set(inspect(conn).get_table_names())

    if "discovered_conflict_groups" not in existing:
        op.create_table(
            "discovered_conflict_groups",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("group_name", sa.Text(), nullable=False),
            sa.Column("members", JSONB, nullable=False),
            sa.Column("default_pick", sa.Text(), nullable=True),
            sa.Column("exclusion_map", JSONB, nullable=True),
            sa.Column("source_query", sa.Text(), nullable=True),
            sa.Column("source_run_id", sa.Text(), nullable=True),
            sa.Column(
                "status",
                sa.String(20),
                nullable=False,
                server_default="pending_review",
            ),
            sa.Column("reviewer_note", sa.Text(), nullable=True),
            sa.Column(
                "discovered_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "ix_discovered_conflict_groups_status",
            "discovered_conflict_groups",
            ["status"],
        )
        op.create_index(
            "ix_discovered_conflict_groups_group_name",
            "discovered_conflict_groups",
            ["group_name"],
        )


def downgrade() -> None:
    op.drop_table("discovered_conflict_groups")
