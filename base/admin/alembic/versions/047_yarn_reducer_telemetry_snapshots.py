"""Persist Yarn tool-result reducer telemetry snapshots from admin scraper.

Revision ID: 047
Revises: 046
Create Date: 2026-04-04
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "047"
down_revision: str | None = "046"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "yarn_reducer_telemetry_snapshots",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_yarn_reducer_telemetry_snapshots_ts",
        "yarn_reducer_telemetry_snapshots",
        [sa.text("captured_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_yarn_reducer_telemetry_snapshots_ts", table_name="yarn_reducer_telemetry_snapshots")
    op.drop_table("yarn_reducer_telemetry_snapshots")
