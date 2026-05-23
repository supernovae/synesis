"""Add auth key attribution to usage metering logs.

Revision ID: 063
Revises: 062
Create Date: 2026-05-22
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "063"
down_revision: str | None = "062"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLES = ("planner_usage_log", "yarn_usage_log")
_COLUMNS = (
    ("auth_method", sa.String(32), ""),
    ("auth_key_id", sa.String(128), ""),
    ("auth_key_name", sa.String(256), ""),
    ("auth_key_prefix", sa.String(32), ""),
)


def _add_columns(table: str) -> None:
    conn = op.get_bind()
    existing = {c["name"] for c in sa.inspect(conn).get_columns(table)}
    for name, col_type, default in _COLUMNS:
        if name not in existing:
            op.add_column(table, sa.Column(name, col_type, nullable=False, server_default=default))
    op.create_index(f"ix_{table}_auth_key", table, ["auth_key_id"], if_not_exists=True)


def upgrade() -> None:
    for table in _TABLES:
        _add_columns(table)


def downgrade() -> None:
    for table in _TABLES:
        op.drop_index(f"ix_{table}_auth_key", table_name=table, if_exists=True)
        for name, _col_type, _default in reversed(_COLUMNS):
            op.drop_column(table, name)
