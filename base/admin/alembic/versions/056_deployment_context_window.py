"""Add context_window to model_deployments for per-model context ceiling.

Revision ID: 056
Revises: 055
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "056"
down_revision: str | None = "055"
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


def downgrade() -> None:
    if _has_column("model_deployments", "context_window"):
        op.drop_column("model_deployments", "context_window")
