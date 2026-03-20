"""Add indexer_stats JSONB to ingestion_items for crawl/fetch telemetry."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "019_ingestion_indexer_stats"
down_revision = "018_admin_audit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ingestion_items",
        sa.Column("indexer_stats", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("ingestion_items", "indexer_stats")
