"""Add tenant_ids column to personal_access_tokens.

Revision ID: 031_pat_tenant_ids
Revises: 030_ingestion_tenant_scope
Create Date: 2026-03-24
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "031_pat_tenant_ids"
down_revision: str | None = "030_ingestion_tenant_scope"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "personal_access_tokens",
        sa.Column("tenant_ids", sa.ARRAY(sa.String(64)), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("personal_access_tokens", "tenant_ids")
