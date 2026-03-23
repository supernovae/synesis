"""Drop serving_endpoints table — serving is now derived from model_deployments.

Revision ID: 027_drop_serving_endpoints
Revises: 026_security_events
Create Date: 2026-03-23
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "027_drop_serving_endpoints"
down_revision: str | None = "026_security_events"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index("ix_serving_endpoints_active", table_name="serving_endpoints")
    op.drop_index("ix_serving_endpoints_provider", table_name="serving_endpoints")
    op.drop_table("serving_endpoints")


def downgrade() -> None:
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
