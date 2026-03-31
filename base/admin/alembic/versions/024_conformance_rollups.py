"""Conformance rollup table for durable telemetry snapshots.

Revision ID: 024_conformance_rollups
Revises: 023_devhub_connector
Create Date: 2026-03-31
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "024_conformance_rollups"
down_revision: str | None = "023_devhub_connector"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "conformance_rollups",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("rollup_id", sa.String(64), nullable=False, unique=True),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source", sa.String(32), nullable=False, server_default="yarn_telemetry"),
        sa.Column("language", sa.String(64), nullable=False, server_default="_global"),
        sa.Column("metrics", sa.dialects.postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("org_id", sa.String(64), nullable=False, server_default=""),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_conformance_rollups_ts", "conformance_rollups", ["timestamp"])
    op.create_index("ix_conformance_rollups_lang", "conformance_rollups", ["language"])
    op.create_index("ix_conformance_rollups_source", "conformance_rollups", ["source"])


def downgrade() -> None:
    op.drop_table("conformance_rollups")
