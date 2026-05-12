"""Add server-side admin browser sessions.

Revision ID: 061_admin_sessions
Revises: 060_remove_litellm_routes
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "061_admin_sessions"
down_revision: str | None = "060_remove_litellm_routes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _has_table(table: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(table)


def upgrade() -> None:
    if _has_table("admin_sessions"):
        return
    op.create_table(
        "admin_sessions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("session_hash", sa.String(length=64), nullable=False, unique=True),
        sa.Column("csrf_token", sa.String(length=64), nullable=False),
        sa.Column("username", sa.String(length=256), nullable=False),
        sa.Column("role", sa.String(length=64), nullable=False, server_default="user"),
        sa.Column("user_id", sa.String(length=256), nullable=False, server_default=""),
        sa.Column("email", sa.String(length=256), nullable=False, server_default=""),
        sa.Column("org_id", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("org_name", sa.String(length=256), nullable=False, server_default=""),
        sa.Column("org_roles", postgresql.ARRAY(sa.String(length=64)), nullable=True),
        sa.Column("access_token", sa.Text(), nullable=False, server_default=""),
        sa.Column("refresh_token", sa.Text(), nullable=False, server_default=""),
        sa.Column("id_token", sa.Text(), nullable=False, server_default=""),
        sa.Column("user_agent", sa.String(length=512), nullable=False, server_default=""),
        sa.Column("ip_address", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_admin_sessions_hash", "admin_sessions", ["session_hash"])
    op.create_index("ix_admin_sessions_user", "admin_sessions", ["user_id"])
    op.create_index("ix_admin_sessions_expires", "admin_sessions", ["expires_at"])


def downgrade() -> None:
    if _has_table("admin_sessions"):
        op.drop_table("admin_sessions")
