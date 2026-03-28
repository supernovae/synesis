"""Add UNIQUE on yarn_usage_log.request_id, client_kind column on yarn_sessions,
and yarn_session_events table for holistic session scoping.

Revision ID: 037_yarn_session_scoping
Revises: 036_cache_compaction_snapshots
Create Date: 2026-03-28

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "037_yarn_session_scoping"
down_revision: str | None = "036_cache_compaction_snapshots"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. UNIQUE index on yarn_usage_log.request_id — required by
    #    ON CONFLICT (request_id) DO NOTHING in usage-writer.ts
    op.create_index(
        "ix_yarn_usage_request_id_unique",
        "yarn_usage_log",
        ["request_id"],
        unique=True,
    )

    # 2. client_kind column on yarn_sessions for per-client scoping
    op.add_column(
        "yarn_sessions",
        sa.Column("client_kind", sa.String(32), nullable=False, server_default="unknown"),
    )

    # 3. yarn_session_events table for DRY failure/extension event recording
    op.create_table(
        "yarn_session_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("session_key", sa.String(256), nullable=False),
        sa.Column("request_id", sa.String(64), nullable=True),
        sa.Column("user_id", sa.String(256), nullable=False, server_default=""),
        sa.Column("org_id", sa.String(256), nullable=False, server_default=""),
        sa.Column("tenant_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("event_kind", sa.String(64), nullable=False),
        sa.Column("component", sa.String(64), nullable=False, server_default=""),
        sa.Column("detail", sa.String(2048), nullable=False, server_default=""),
        sa.Column("metadata_json", sa.dialects.postgresql.JSONB, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_yarn_session_events_session", "yarn_session_events", ["session_key"])
    op.create_index("ix_yarn_session_events_kind", "yarn_session_events", ["event_kind"])
    op.create_index("ix_yarn_session_events_created", "yarn_session_events", ["created_at"])
    op.create_index("ix_yarn_session_events_user", "yarn_session_events", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_yarn_session_events_user", table_name="yarn_session_events")
    op.drop_index("ix_yarn_session_events_created", table_name="yarn_session_events")
    op.drop_index("ix_yarn_session_events_kind", table_name="yarn_session_events")
    op.drop_index("ix_yarn_session_events_session", table_name="yarn_session_events")
    op.drop_table("yarn_session_events")
    op.drop_column("yarn_sessions", "client_kind")
    op.drop_index("ix_yarn_usage_request_id_unique", table_name="yarn_usage_log")
