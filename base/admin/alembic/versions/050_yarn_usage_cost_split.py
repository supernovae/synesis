"""Add split estimated/actual cost columns to yarn_usage_log.

Revision ID: 050
Revises: 049
Create Date: 2026-04-07
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "050"
down_revision: str | None = "049"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    cols = {c["name"] for c in inspector.get_columns("yarn_usage_log")}

    if "estimated_cost_usd" not in cols:
        op.add_column(
            "yarn_usage_log",
            sa.Column("estimated_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
        )
    if "actual_cost_usd" not in cols:
        op.add_column(
            "yarn_usage_log",
            sa.Column("actual_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
        )

    # Backfill estimated cost from legacy cost_usd when present.
    if "cost_usd" in cols:
        op.execute(
            sa.text(
                """
                UPDATE yarn_usage_log
                SET estimated_cost_usd = COALESCE(cost_usd, 0)
                WHERE COALESCE(estimated_cost_usd, 0) = 0
                  AND COALESCE(actual_cost_usd, 0) = 0
                  AND COALESCE(cost_usd, 0) > 0
                """
            )
        )


def downgrade() -> None:
    op.drop_column("yarn_usage_log", "actual_cost_usd")
    op.drop_column("yarn_usage_log", "estimated_cost_usd")
