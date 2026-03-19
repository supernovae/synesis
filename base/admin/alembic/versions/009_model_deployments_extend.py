"""Extend model_deployments with source, litellm_params, is_active, description, notes, litellm_model_id.

Revision ID: 009
Revises: 008
Create Date: 2026-03-18

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "009"
down_revision: str | None = "008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    columns = {col["name"] for col in sa.inspect(conn).get_columns("model_deployments")}

    if "source" not in columns:
        op.add_column(
            "model_deployments",
            sa.Column("source", sa.String(32), nullable=False, server_default="local"),
        )
    if "litellm_params" not in columns:
        op.add_column(
            "model_deployments",
            sa.Column("litellm_params", sa.JSON(), nullable=True),
        )
    if "is_active" not in columns:
        op.add_column(
            "model_deployments",
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        )
    if "description" not in columns:
        op.add_column(
            "model_deployments",
            sa.Column("description", sa.Text(), nullable=False, server_default=""),
        )
    if "notes" not in columns:
        op.add_column(
            "model_deployments",
            sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        )
    if "litellm_model_id" not in columns:
        op.add_column(
            "model_deployments",
            sa.Column("litellm_model_id", sa.String(128), nullable=True),
        )

    indexes = {idx["name"] for idx in sa.inspect(conn).get_indexes("model_deployments")}
    if "ix_model_deployments_is_active" not in indexes:
        op.create_index(
            "ix_model_deployments_is_active",
            "model_deployments",
            ["is_active"],
        )
    if "ix_model_deployments_source" not in indexes:
        op.create_index(
            "ix_model_deployments_source",
            "model_deployments",
            ["source"],
        )


def downgrade() -> None:
    op.drop_index("ix_model_deployments_source", table_name="model_deployments")
    op.drop_index("ix_model_deployments_is_active", table_name="model_deployments")
    op.drop_column("model_deployments", "litellm_model_id")
    op.drop_column("model_deployments", "notes")
    op.drop_column("model_deployments", "description")
    op.drop_column("model_deployments", "is_active")
    op.drop_column("model_deployments", "litellm_params")
    op.drop_column("model_deployments", "source")
