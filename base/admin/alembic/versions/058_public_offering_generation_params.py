"""Add generation params to public offerings.

Revision ID: 058_public_gen_params
Revises: 057_nornic_content_graph
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "058_public_gen_params"
down_revision: str | None = "057_nornic_content_graph"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _has_column(table: str, column: str) -> bool:
    return any(c["name"] == column for c in sa.inspect(op.get_bind()).get_columns(table))


def upgrade() -> None:
    if not _has_column("model_deployments", "context_window"):
        op.add_column(
            "model_deployments",
            sa.Column("context_window", sa.Integer(), nullable=True),
        )
    if not _has_column("model_public_offering", "generation_params"):
        op.add_column(
            "model_public_offering",
            sa.Column(
                "generation_params",
                postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite"),
                nullable=True,
            ),
        )


def downgrade() -> None:
    if _has_column("model_public_offering", "generation_params"):
        op.drop_column("model_public_offering", "generation_params")
