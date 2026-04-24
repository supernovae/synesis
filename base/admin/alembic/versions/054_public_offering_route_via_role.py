"""Add route_via_role to public offerings (inherit URL/keys from a coder deployment).

Revision ID: 054
Revises: 053
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "054"
down_revision: str | None = "053"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "model_public_offering",
        sa.Column("route_via_role", sa.String(length=64), nullable=True),
    )
    op.execute(
        sa.text(
            "UPDATE model_public_offering SET route_via_role = 'coder-' || effort_tier "
            "WHERE route_via_role IS NULL AND effort_tier IS NOT NULL"
        )
    )


def downgrade() -> None:
    op.drop_column("model_public_offering", "route_via_role")
