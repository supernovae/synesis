"""Vendor + Serving management tables.

Revision ID: 023_vendor_serving_mgmt
Revises: 022_rbac_usage_rollups
Create Date: 2026-03-22
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "023_vendor_serving_mgmt"
down_revision: str | None = "022_rbac_usage_rollups"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "provider_configs",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("provider_key", sa.String(64), unique=True, nullable=False),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("default_max_tokens", sa.Integer, nullable=False, server_default=sa.text("8192")),
        sa.Column("default_temperature", sa.Float, nullable=False, server_default=sa.text("0.1")),
        sa.Column("allowed_roles", sa.dialects.postgresql.ARRAY(sa.String(64)), nullable=True),
        sa.Column("policies", sa.dialects.postgresql.JSONB, nullable=True),
        sa.Column("notes", sa.Text, nullable=False, server_default=sa.text("''")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "serving_endpoints",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(128), unique=True, nullable=False),
        sa.Column("provider", sa.String(64), nullable=False),
        sa.Column("model", sa.String(256), nullable=False),
        sa.Column("endpoint_url", sa.Text, nullable=False, server_default=sa.text("''")),
        sa.Column("api_key_env", sa.String(128), nullable=False, server_default=sa.text("''")),
        sa.Column("allowed_roles", sa.dialects.postgresql.ARRAY(sa.String(64)), nullable=True),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("notes", sa.Text, nullable=False, server_default=sa.text("''")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_serving_endpoints_provider", "serving_endpoints", ["provider"])
    op.create_index("ix_serving_endpoints_active", "serving_endpoints", ["is_active"])


def downgrade() -> None:
    op.drop_index("ix_serving_endpoints_active", table_name="serving_endpoints")
    op.drop_index("ix_serving_endpoints_provider", table_name="serving_endpoints")
    op.drop_table("serving_endpoints")
    op.drop_table("provider_configs")
