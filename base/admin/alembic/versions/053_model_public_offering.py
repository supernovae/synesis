"""Add model_public_offering for client-facing model ids (planner/yarn catalogs).

Revision ID: 053
Revises: 052
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "053"
down_revision: str | None = "052"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "model_public_offering",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("client_model_id", sa.String(length=128), nullable=False),
        sa.Column("label", sa.String(length=256), nullable=True),
        sa.Column("effort_tier", sa.String(length=16), nullable=False),
        sa.Column("backend_model_override", sa.Text(), nullable=True),
        sa.Column("expose_planner", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("expose_yarn", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_model_public_offering_client_model_id", "model_public_offering", ["client_model_id"], unique=True)
    op.create_index("ix_model_public_offering_is_active", "model_public_offering", ["is_active"])
    op.create_index(
        "ix_model_public_offering_active_expose",
        "model_public_offering",
        ["is_active", "expose_planner", "expose_yarn"],
    )


def downgrade() -> None:
    op.drop_index("ix_model_public_offering_active_expose", table_name="model_public_offering")
    op.drop_index("ix_model_public_offering_is_active", table_name="model_public_offering")
    op.drop_index("ix_model_public_offering_client_model_id", table_name="model_public_offering")
    op.drop_table("model_public_offering")
