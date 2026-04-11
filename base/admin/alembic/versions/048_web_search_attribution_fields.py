"""Add attribution and policy columns to web_search_log.

Revision ID: 048
Revises: 047
Create Date: 2026-04-04
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "048"
down_revision: str | None = "047"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("web_search_log") as batch:
        batch.add_column(sa.Column("org_id", sa.String(length=256), nullable=False, server_default=""))
        batch.add_column(sa.Column("user_id", sa.String(length=256), nullable=False, server_default=""))
        batch.add_column(sa.Column("tenant_id", sa.String(length=64), nullable=False, server_default=""))
        batch.add_column(sa.Column("request_id", sa.String(length=128), nullable=False, server_default=""))
        batch.add_column(sa.Column("session_key", sa.String(length=256), nullable=False, server_default=""))
        batch.add_column(sa.Column("conversation_id", sa.String(length=256), nullable=False, server_default=""))
        batch.add_column(sa.Column("trace_id", sa.String(length=128), nullable=False, server_default=""))
        batch.add_column(sa.Column("source_surface", sa.String(length=64), nullable=False, server_default=""))
        batch.add_column(sa.Column("tool_name", sa.String(length=64), nullable=False, server_default=""))
        batch.add_column(sa.Column("query_hash", sa.String(length=64), nullable=False, server_default=""))
        batch.add_column(sa.Column("rate_bucket_key", sa.String(length=256), nullable=False, server_default=""))
        batch.add_column(sa.Column("blocked_reason", sa.String(length=128), nullable=False, server_default=""))
        batch.add_column(sa.Column("policy_action", sa.String(length=32), nullable=False, server_default="allow"))
        batch.add_column(sa.Column("token_estimate", sa.Integer(), nullable=False, server_default="0"))

    op.create_index("ix_web_search_log_org_id", "web_search_log", ["org_id"])
    op.create_index("ix_web_search_log_source_surface", "web_search_log", ["source_surface"])
    op.create_index("ix_web_search_log_request_id", "web_search_log", ["request_id"])
    op.create_index("ix_web_search_log_session_key", "web_search_log", ["session_key"])
    op.create_index("ix_web_search_log_trace_id", "web_search_log", ["trace_id"])


def downgrade() -> None:
    op.drop_index("ix_web_search_log_trace_id", table_name="web_search_log")
    op.drop_index("ix_web_search_log_session_key", table_name="web_search_log")
    op.drop_index("ix_web_search_log_request_id", table_name="web_search_log")
    op.drop_index("ix_web_search_log_source_surface", table_name="web_search_log")
    op.drop_index("ix_web_search_log_org_id", table_name="web_search_log")

    with op.batch_alter_table("web_search_log") as batch:
        batch.drop_column("token_estimate")
        batch.drop_column("policy_action")
        batch.drop_column("blocked_reason")
        batch.drop_column("rate_bucket_key")
        batch.drop_column("query_hash")
        batch.drop_column("tool_name")
        batch.drop_column("source_surface")
        batch.drop_column("trace_id")
        batch.drop_column("conversation_id")
        batch.drop_column("session_key")
        batch.drop_column("request_id")
        batch.drop_column("tenant_id")
        batch.drop_column("user_id")
        batch.drop_column("org_id")
