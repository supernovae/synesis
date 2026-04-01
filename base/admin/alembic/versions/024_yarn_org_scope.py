"""Add org scoping columns to Yarn usage tables.

Revision ID: 024_yarn_org_scope
Revises: 023_vendor_serving_mgmt
Create Date: 2026-03-22
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "024_yarn_org_scope"
down_revision: str | None = "023_vendor_serving_mgmt"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("yarn_sessions", sa.Column("org_id", sa.String(256), nullable=False, server_default=""))
    op.add_column("yarn_usage_log", sa.Column("org_id", sa.String(256), nullable=False, server_default=""))

    op.create_index("ix_yarn_sessions_org_id", "yarn_sessions", ["org_id"])
    op.create_index("ix_yarn_usage_org", "yarn_usage_log", ["org_id"])

    # Clear server defaults after backfill to keep schema tidy.
    op.alter_column("yarn_sessions", "org_id", server_default=None)
    op.alter_column("yarn_usage_log", "org_id", server_default=None)


def downgrade() -> None:
    op.drop_index("ix_yarn_usage_org", table_name="yarn_usage_log")
    op.drop_index("ix_yarn_sessions_org_id", table_name="yarn_sessions")

    op.drop_column("yarn_usage_log", "org_id")
    op.drop_column("yarn_sessions", "org_id")
