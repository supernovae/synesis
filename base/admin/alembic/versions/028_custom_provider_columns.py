"""Add columns for user-defined custom providers.

Revision ID: 028_custom_provider_columns
Revises: 027_drop_serving_endpoints
Create Date: 2026-03-23
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "028_custom_provider_columns"
down_revision: str | None = "027_drop_serving_endpoints"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "provider_configs", sa.Column("is_custom", sa.Boolean, nullable=False, server_default=sa.text("false"))
    )
    op.add_column("provider_configs", sa.Column("label", sa.String(128), nullable=True))
    op.add_column("provider_configs", sa.Column("litellm_prefix", sa.String(64), nullable=True))
    op.add_column("provider_configs", sa.Column("api_key_env", sa.String(128), nullable=True))
    op.add_column("provider_configs", sa.Column("needs_endpoint", sa.Boolean, nullable=True))
    op.add_column("provider_configs", sa.Column("placeholder", sa.String(256), nullable=True))
    op.add_column("provider_configs", sa.Column("is_local", sa.Boolean, nullable=True, server_default=sa.text("false")))


def downgrade() -> None:
    op.drop_column("provider_configs", "is_local")
    op.drop_column("provider_configs", "placeholder")
    op.drop_column("provider_configs", "needs_endpoint")
    op.drop_column("provider_configs", "api_key_env")
    op.drop_column("provider_configs", "litellm_prefix")
    op.drop_column("provider_configs", "label")
    op.drop_column("provider_configs", "is_custom")
