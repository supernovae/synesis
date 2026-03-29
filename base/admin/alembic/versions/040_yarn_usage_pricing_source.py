"""Add pricing_source column to yarn_usage_log.

Tracks how each request's cost was derived: provider, manual, infra_calc,
api_lookup, fallback_base, or unknown.  Existing rows default to 'unknown'.

Revision ID: 040
Revises: 039
Create Date: 2026-03-29

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "040"
down_revision: str | None = "039"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "yarn_usage_log",
        sa.Column(
            "pricing_source",
            sa.String(32),
            nullable=False,
            server_default="unknown",
        ),
    )


def downgrade() -> None:
    op.drop_column("yarn_usage_log", "pricing_source")
