"""Add adapter_hint column to model_deployments.

Revision ID: 051
Revises: 050
Create Date: 2026-04-09
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "051"
down_revision: str | None = "050"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    cols = {c["name"] for c in inspector.get_columns("model_deployments")}

    if "adapter_hint" not in cols:
        op.add_column(
            "model_deployments",
            sa.Column("adapter_hint", sa.String(32), nullable=True),
        )


def downgrade() -> None:
    op.drop_column("model_deployments", "adapter_hint")
