"""Add cache billing breakdown columns for usage audit.

Revision ID: 062
Revises: 061_admin_sessions
Create Date: 2026-05-22
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "062"
down_revision: str | None = "061_admin_sessions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_COLUMNS = (
    ("tokens_uncached_input", sa.Integer(), "0"),
    ("tokens_cache_read", sa.Integer(), "0"),
    ("tokens_cache_write", sa.Integer(), "0"),
    ("input_cost_usd", sa.Float(), "0.0"),
    ("cache_read_cost_usd", sa.Float(), "0.0"),
    ("cache_write_cost_usd", sa.Float(), "0.0"),
    ("output_cost_usd", sa.Float(), "0.0"),
    ("estimated_no_cache_cost_usd", sa.Float(), "0.0"),
    ("cache_savings_usd", sa.Float(), "0.0"),
)


def _add_columns(table: str) -> None:
    conn = op.get_bind()
    existing = {c["name"] for c in sa.inspect(conn).get_columns(table)}
    for name, col_type, default in _COLUMNS:
        if name not in existing:
            op.add_column(table, sa.Column(name, col_type, nullable=False, server_default=default))
    op.execute(
        sa.text(
            f"""
            UPDATE {table}
            SET
              tokens_uncached_input = GREATEST(COALESCE(tokens_in, 0) - COALESCE(tokens_cached, 0), 0),
              tokens_cache_read = COALESCE(tokens_cached, 0),
              tokens_cache_write = COALESCE(tokens_cache_write, 0),
              estimated_no_cache_cost_usd = CASE
                WHEN COALESCE(estimated_no_cache_cost_usd, 0) = 0 THEN COALESCE(estimated_cost_usd, 0)
                ELSE estimated_no_cache_cost_usd
              END,
              cache_savings_usd = CASE
                WHEN COALESCE(cache_savings_usd, 0) = 0 THEN
                  GREATEST(COALESCE(estimated_no_cache_cost_usd, estimated_cost_usd, 0) - COALESCE(estimated_cost_usd, 0), 0)
                ELSE cache_savings_usd
              END
            """
        )
    )


def upgrade() -> None:
    _add_columns("planner_usage_log")
    _add_columns("yarn_usage_log")


def downgrade() -> None:
    for table in ("planner_usage_log", "yarn_usage_log"):
        for name, _col_type, _default in reversed(_COLUMNS):
            op.drop_column(table, name)
