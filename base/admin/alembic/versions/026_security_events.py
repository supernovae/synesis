"""Add security_events table for guardrail detections and admin actions.

Revision ID: 026_security_events
Revises: 025_pat_scopes
Create Date: 2026-03-22
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "026_security_events"
down_revision: str | None = "025_pat_scopes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "security_events",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("event_id", sa.String(64), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("event_type", sa.String(64), nullable=False),
        sa.Column("severity", sa.String(16), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False, default=0.0),
        sa.Column("confidence_band", sa.String(16), nullable=False, default="low"),
        sa.Column("action_taken", sa.String(32), nullable=False),
        sa.Column("scope", sa.String(16), nullable=False, default="request"),
        sa.Column("service", sa.String(32), nullable=False, default=""),
        sa.Column("request_id", sa.String(128), nullable=False, default=""),
        sa.Column("session_id", sa.String(256), nullable=False, default=""),
        sa.Column("user_id", sa.String(256), nullable=False, default=""),
        sa.Column("token_id", sa.String(64), nullable=False, default=""),
        sa.Column("org_id", sa.String(256), nullable=False, default=""),
        sa.Column("patterns_found", postgresql.ARRAY(sa.String(128)), nullable=True),
        sa.Column("excerpt", sa.Text(), nullable=False, default=""),
        sa.Column("scanner_name", sa.String(64), nullable=False, default=""),
        sa.Column("latency_ms", sa.Float(), nullable=False, default=0.0),
        sa.Column("detail", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("resolved", sa.Boolean(), nullable=False, default=False),
        sa.Column("resolved_by", sa.String(256), nullable=False, default=""),
        sa.Column("resolved_action", sa.String(64), nullable=False, default=""),
        sa.Column("resolved_reason", sa.Text(), nullable=False, default=""),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_security_events_created_at", "security_events", ["created_at"])
    op.create_index("ix_security_events_event_type", "security_events", ["event_type"])
    op.create_index("ix_security_events_severity", "security_events", ["severity"])
    op.create_index("ix_security_events_user_id", "security_events", ["user_id"])
    op.create_index("ix_security_events_org_id", "security_events", ["org_id"])
    op.create_index("ix_security_events_resolved", "security_events", ["resolved"])


def downgrade() -> None:
    op.drop_table("security_events")
