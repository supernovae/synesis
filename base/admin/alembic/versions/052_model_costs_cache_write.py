"""Add optional cache-write (prompt cache creation) rate to model_costs.

Revision ID: 052
Revises: 051
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "052"
down_revision: str | None = "051"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "model_costs",
        sa.Column("input_cache_write_per_million", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("model_costs", "input_cache_write_per_million")
