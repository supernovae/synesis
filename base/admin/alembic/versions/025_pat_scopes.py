"""Add scopes column to personal_access_tokens.

Revision ID: 025_pat_scopes
Revises: 024_yarn_org_scope
Create Date: 2026-03-22
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "025_pat_scopes"
down_revision: str | None = "024_yarn_org_scope"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "personal_access_tokens",
        sa.Column("scopes", sa.ARRAY(sa.String(32)), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("personal_access_tokens", "scopes")
