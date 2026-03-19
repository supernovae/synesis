"""Add personal_access_tokens table for Keycloak PAT auth.

Revision ID: 011
Revises: 010
Create Date: 2026-03-19

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "011"
down_revision: str | None = "010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "personal_access_tokens",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("username", sa.String(), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("token_prefix", sa.String(12), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False, server_default="user"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.create_index("ix_pat_user_id", "personal_access_tokens", ["user_id"])
    op.create_index("ix_pat_token_hash", "personal_access_tokens", ["token_hash"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_pat_token_hash", table_name="personal_access_tokens")
    op.drop_index("ix_pat_user_id", table_name="personal_access_tokens")
    op.drop_table("personal_access_tokens")
