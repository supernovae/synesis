"""Add prefix_cache_snapshots and compaction_snapshots tables for telemetry persistence.

Revision ID: 036
Revises: 035
Create Date: 2026-03-27

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "036"
down_revision: str | None = "035"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "prefix_cache_snapshots",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("service", sa.String(32), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("prompt_tokens", sa.BigInteger, nullable=False, default=0),
        sa.Column("cached_prompt_tokens", sa.BigInteger, nullable=False, default=0),
        sa.Column("hit_rate", sa.Float, nullable=False, default=0.0),
        sa.Column("cache_mode", sa.String(16), nullable=False, default="auto"),
        sa.Column("requests", sa.Integer, nullable=False, default=0),
        sa.Column("estimated_savings_usd", sa.Float, nullable=False, default=0.0),
    )
    op.create_index(
        "ix_prefix_cache_snapshots_svc_ts",
        "prefix_cache_snapshots",
        ["service", sa.text("captured_at DESC")],
    )

    op.create_table(
        "compaction_snapshots",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("service", sa.String(32), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("compaction_count", sa.Integer, nullable=False, default=0),
        sa.Column("chars_before", sa.BigInteger, nullable=False, default=0),
        sa.Column("chars_after", sa.BigInteger, nullable=False, default=0),
        sa.Column("tokens_saved_estimate", sa.BigInteger, nullable=False, default=0),
        sa.Column("errors", sa.Integer, nullable=False, default=0),
        sa.Column("detail", sa.dialects.postgresql.JSONB, nullable=True),
    )
    op.create_index(
        "ix_compaction_snapshots_svc_ts",
        "compaction_snapshots",
        ["service", sa.text("captured_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_compaction_snapshots_svc_ts", table_name="compaction_snapshots")
    op.drop_table("compaction_snapshots")
    op.drop_index("ix_prefix_cache_snapshots_svc_ts", table_name="prefix_cache_snapshots")
    op.drop_table("prefix_cache_snapshots")
