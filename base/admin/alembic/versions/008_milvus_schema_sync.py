"""Add milvus_schema_sync table for tracking Milvus schema version drift.

When the indexer bumps the Milvus schema (e.g. v6 → v7), the collection is
dropped and recreated. This table lets the admin service detect the change
and reset all 'indexed' ingestion items back to 'pending' for re-indexing.

Revision ID: 008
Revises: 007
Create Date: 2026-03-18

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "008"
down_revision: str | None = "007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    tables = sa.inspect(conn).get_table_names()
    if "milvus_schema_sync" in tables:
        return

    op.create_table(
        "milvus_schema_sync",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("collection", sa.String(128), nullable=False, unique=True),
        sa.Column("schema_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_reset_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_reported_by", sa.String(128), nullable=False, server_default=""),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("milvus_schema_sync")
