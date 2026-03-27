"""Add yarn_safety_events table for policy engine event logging.

Revision ID: 035
Revises: 034
Create Date: 2026-03-25

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "035"
down_revision: str | None = "034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "yarn_safety_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("session_key", sa.String(256), nullable=False),
        sa.Column("user_id", sa.String(256), nullable=False, server_default=""),
        sa.Column("org_id", sa.String(256), nullable=False, server_default=""),
        sa.Column("tenant_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("event_kind", sa.String(64), nullable=False),
        sa.Column("detail", sa.String(1024), nullable=False, server_default=""),
        sa.Column("repeat_count", sa.Integer(), nullable=True),
        sa.Column("tokens_burned", sa.Integer(), nullable=True),
        sa.Column("consecutive_tool_calls", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_yarn_safety_session", "yarn_safety_events", ["session_key"])
    op.create_index("ix_yarn_safety_user", "yarn_safety_events", ["user_id"])
    op.create_index("ix_yarn_safety_kind", "yarn_safety_events", ["event_kind"])
    op.create_index("ix_yarn_safety_created", "yarn_safety_events", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_yarn_safety_created", table_name="yarn_safety_events")
    op.drop_index("ix_yarn_safety_kind", table_name="yarn_safety_events")
    op.drop_index("ix_yarn_safety_user", table_name="yarn_safety_events")
    op.drop_index("ix_yarn_safety_session", table_name="yarn_safety_events")
    op.drop_table("yarn_safety_events")
