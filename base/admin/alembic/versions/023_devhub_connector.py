"""Developer Hub connector configuration table.

Revision ID: 023_devhub_connector
Revises: 022_rbac_usage_rollups
Create Date: 2026-03-30
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "023_devhub_connector"
down_revision: str | None = "022_rbac_usage_rollups"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "devhub_connectors",
        sa.Column("id", sa.Integer(), autoincrement=True, primary_key=True),
        sa.Column("connector_id", sa.String(64), nullable=False, unique=True),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("base_url", sa.String(512), nullable=False),
        sa.Column("auth_type", sa.String(16), nullable=False, server_default="none"),
        sa.Column("auth_token_ref", sa.String(256), nullable=False, server_default=""),
        sa.Column("entity_kinds", sa.dialects.postgresql.JSONB(), nullable=True),
        sa.Column("sync_interval_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_sync_status", sa.String(32), nullable=False, server_default="never"),
        sa.Column("last_sync_summary", sa.dialects.postgresql.JSONB(), nullable=True),
        sa.Column("cached_entity_snapshot", sa.dialects.postgresql.JSONB(), nullable=True),
        sa.Column("org_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("scope", sa.String(16), nullable=False, server_default="org"),
        sa.Column("scope_value", sa.String(256), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_devhub_connectors_org", "devhub_connectors", ["org_id"])
    op.create_index("ix_devhub_connectors_enabled", "devhub_connectors", ["enabled"])


def downgrade() -> None:
    op.drop_table("devhub_connectors")
