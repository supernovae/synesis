"""Add default_endpoint to provider_configs for OpenAI-compatible base URL hints.

Revision ID: 039
Revises: 038
Create Date: 2026-03-28

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "039"
down_revision: str | None = "038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "provider_configs",
        sa.Column("default_endpoint", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("provider_configs", "default_endpoint")
