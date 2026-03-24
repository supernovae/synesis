"""Add tenant_id to traces, usage_rollups, yarn_sessions, yarn_usage_log.

Revision ID: 033_tenant_observability
Revises: 032_acl_groups
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "033_tenant_observability"
down_revision: str | None = "032_acl_groups"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("traces", sa.Column("org_id", sa.String(64), nullable=False, server_default=""))
    op.add_column("traces", sa.Column("tenant_id", sa.String(64), nullable=False, server_default=""))
    op.create_index("ix_traces_org_id", "traces", ["org_id"])
    op.create_index("ix_traces_tenant_id", "traces", ["tenant_id"])

    op.add_column("usage_rollups", sa.Column("tenant_id", sa.String(64), nullable=False, server_default=""))
    op.create_index("ix_usage_rollups_tenant_id", "usage_rollups", ["tenant_id"])

    op.add_column("yarn_sessions", sa.Column("tenant_id", sa.String(64), nullable=False, server_default=""))
    op.create_index("ix_yarn_sessions_tenant_id", "yarn_sessions", ["tenant_id"])

    op.add_column("yarn_usage_log", sa.Column("tenant_id", sa.String(64), nullable=False, server_default=""))
    op.create_index("ix_yarn_usage_log_tenant_id", "yarn_usage_log", ["tenant_id"])


def downgrade() -> None:
    for tbl in ("yarn_usage_log", "yarn_sessions", "usage_rollups", "traces"):
        op.drop_index(f"ix_{tbl}_tenant_id", table_name=tbl)
        op.drop_column(tbl, "tenant_id")
    op.drop_index("ix_traces_org_id", table_name="traces")
    op.drop_column("traces", "org_id")
