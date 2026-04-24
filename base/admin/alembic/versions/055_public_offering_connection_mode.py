"""Add standalone connection fields for public offerings.

Revision ID: 055
Revises: 054
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "055"
down_revision: str | None = "054"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "model_public_offering",
        sa.Column(
            "connection_mode",
            sa.String(length=16),
            nullable=False,
            server_default="role_clone",
        ),
    )
    op.add_column(
        "model_public_offering",
        sa.Column("standalone_provider", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "model_public_offering",
        sa.Column("standalone_endpoint", sa.Text(), nullable=True),
    )
    op.add_column(
        "model_public_offering",
        sa.Column("standalone_api_key_env", sa.String(length=128), nullable=True),
    )
    op.execute(
        sa.text(
            "UPDATE model_public_offering "
            "SET connection_mode = 'role_clone' "
            "WHERE connection_mode IS NULL OR connection_mode = ''"
        )
    )


def downgrade() -> None:
    op.drop_column("model_public_offering", "standalone_api_key_env")
    op.drop_column("model_public_offering", "standalone_endpoint")
    op.drop_column("model_public_offering", "standalone_provider")
    op.drop_column("model_public_offering", "connection_mode")
