"""Compositional pattern library for Layer 2 recall.

Revision ID: 043
Revises: 042
Create Date: 2026-03-31
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY

revision: str = "043"
down_revision: str | None = "042"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "pattern_entries",
        sa.Column("id", sa.Integer(), autoincrement=True, primary_key=True),
        sa.Column("pattern_id", sa.String(128), nullable=False, unique=True),
        sa.Column("language", sa.String(64), nullable=False),
        sa.Column("framework", sa.String(128), nullable=False, server_default=""),
        sa.Column("skill_family", sa.String(64), nullable=False),
        sa.Column("code_block", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("constraints", sa.Text(), nullable=False, server_default=""),
        sa.Column("test_snippet", sa.Text(), nullable=False, server_default=""),
        sa.Column("trust_score", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("usage_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_validated", sa.DateTime(timezone=True), nullable=True),
        sa.Column("org_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("scope", sa.String(16), nullable=False, server_default="global"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("tags", ARRAY(sa.String(64)), nullable=True),
        sa.Column("content_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(256), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_pattern_entries_language", "pattern_entries", ["language"])
    op.create_index("ix_pattern_entries_skill_family", "pattern_entries", ["skill_family"])
    op.create_index("ix_pattern_entries_org_id", "pattern_entries", ["org_id"])
    op.create_index("ix_pattern_entries_enabled", "pattern_entries", ["enabled"])


def downgrade() -> None:
    op.drop_table("pattern_entries")
