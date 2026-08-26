"""Add ingestion_sources, ingestion_items, and ingestion_runs tables.

Revision ID: 006
Revises: 005
Create Date: 2026-03-17

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY

revision: str = "006"
down_revision: str | None = "005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    from sqlalchemy import inspect

    conn = op.get_bind()
    existing = set(inspect(conn).get_table_names())

    if "ingestion_sources" not in existing:
        op.create_table(
            "ingestion_sources",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("name", sa.String(256), nullable=False),
            sa.Column("handler", sa.String(64), nullable=False, server_default="seed_corpus"),
            sa.Column("origin_type", sa.String(32), nullable=False, server_default="curated"),
            sa.Column("authority", sa.String(32), nullable=False, server_default="vetted"),
            sa.Column("domain", sa.String(128), nullable=False, server_default=""),
            sa.Column("config", sa.JSON(), nullable=True),
            sa.Column("tags", ARRAY(sa.String(64)), nullable=True),
            sa.Column("status", sa.String(16), nullable=False, server_default="active"),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_ingestion_sources_status", "ingestion_sources", ["status"])
        op.create_index("ix_ingestion_sources_domain", "ingestion_sources", ["domain"])

    if "ingestion_items" not in existing:
        op.create_table(
            "ingestion_items",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("source_id", sa.Integer(), sa.ForeignKey("ingestion_sources.id"), nullable=True),
            sa.Column("url", sa.Text(), nullable=False),
            sa.Column("title", sa.Text(), nullable=False, server_default=""),
            sa.Column("domain", sa.String(128), nullable=False, server_default=""),
            sa.Column("tags", ARRAY(sa.String(64)), nullable=True),
            sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
            sa.Column(
                "status",
                sa.String(16),
                nullable=False,
                server_default="pending",
            ),
            sa.Column("chunk_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("error_message", sa.Text(), nullable=False, server_default=""),
            sa.Column("graph_node_id", sa.String(128), nullable=False, server_default=""),
            sa.Column("queued_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_ingestion_items_status", "ingestion_items", ["status"])
        op.create_index("ix_ingestion_items_source_id", "ingestion_items", ["source_id"])
        op.create_index("ix_ingestion_items_domain", "ingestion_items", ["domain"])

    if "ingestion_runs" not in existing:
        op.create_table(
            "ingestion_runs",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("source_id", sa.Integer(), sa.ForeignKey("ingestion_sources.id"), nullable=True),
            sa.Column("trigger", sa.String(16), nullable=False, server_default="manual"),
            sa.Column("status", sa.String(16), nullable=False, server_default="running"),
            sa.Column("items_total", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("items_indexed", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("items_failed", sa.Integer(), nullable=False, server_default="0"),
            sa.Column(
                "started_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_ingestion_runs_source_id", "ingestion_runs", ["source_id"])
        op.create_index("ix_ingestion_runs_status", "ingestion_runs", ["status"])


def downgrade() -> None:
    op.drop_table("ingestion_runs")
    op.drop_table("ingestion_items")
    op.drop_table("ingestion_sources")
