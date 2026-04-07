"""Add split estimated/actual cost columns to yarn_sessions.

Revision ID: 049
Revises: 048
Create Date: 2026-04-07
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "049"
down_revision: str | None = "048"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    cols = {c["name"] for c in inspector.get_columns("yarn_sessions")}

    if "total_estimated_cost_usd" not in cols:
        op.add_column(
            "yarn_sessions",
            sa.Column("total_estimated_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
        )
    if "total_actual_cost_usd" not in cols:
        op.add_column(
            "yarn_sessions",
            sa.Column("total_actual_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
        )

    # Backfill estimated cost from legacy total_cost_usd when present.
    if "total_cost_usd" in cols:
        op.execute(
            sa.text(
                """
                UPDATE yarn_sessions
                SET total_estimated_cost_usd = COALESCE(total_estimated_cost_usd, 0) + COALESCE(total_cost_usd, 0)
                WHERE COALESCE(total_estimated_cost_usd, 0) = 0
                  AND COALESCE(total_actual_cost_usd, 0) = 0
                  AND COALESCE(total_cost_usd, 0) > 0
                """
            )
        )


def downgrade() -> None:
    op.drop_column("yarn_sessions", "total_actual_cost_usd")
    op.drop_column("yarn_sessions", "total_estimated_cost_usd")
