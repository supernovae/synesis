"""Add tokens_saved columns to yarn tables for tracking reduction savings.

Revision ID: 038
Revises: 037_yarn_session_scoping
Create Date: 2026-03-28

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "038"
down_revision: str | None = "037_yarn_session_scoping"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "yarn_sessions",
        sa.Column("total_tokens_saved", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "yarn_usage_log",
        sa.Column("tokens_saved_by_reduction", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("yarn_usage_log", "tokens_saved_by_reduction")
    op.drop_column("yarn_sessions", "total_tokens_saved")
