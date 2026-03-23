"""Add model_policies table for conditional model selection.

Revision ID: 029_model_policies
Revises: 028_custom_provider_columns
Create Date: 2026-03-23
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "029_model_policies"
down_revision: str | None = "028_custom_provider_columns"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "model_policies",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("role", sa.String(64), nullable=False, index=True),
        sa.Column("priority", sa.Integer, nullable=False, default=0),
        sa.Column("condition_type", sa.String(32), nullable=False),
        sa.Column("condition_value", sa.String(128), nullable=False, server_default=""),
        sa.Column("model", sa.String(256), nullable=False),
        sa.Column("label", sa.String(128), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_model_policies_role_priority", "model_policies", ["role", "priority"])


def downgrade() -> None:
    op.drop_index("ix_model_policies_role_priority", table_name="model_policies")
    op.drop_table("model_policies")
