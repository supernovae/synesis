"""Add raw_scorecard JSONB column to quality_snapshots.

Stores the full audit scorecard JSON so domain-detail pages can surface
MRR, hit-rate, and dead-weight samples without the mounted JSON file.

Revision ID: 013
Revises: 012
Create Date: 2026-03-20

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "013"
down_revision: str | None = "012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("quality_snapshots", sa.Column("raw_scorecard", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("quality_snapshots", "raw_scorecard")
