"""Rename Milvus catalog bookkeeping to NornicDB content graph.

Revision ID: 057_nornic_content_graph
Revises: 056
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "057_nornic_content_graph"
down_revision: str | None = "056"
branch_labels = None
depends_on = None


def _has_table(conn: sa.Connection, table: str) -> bool:
    return table in sa.inspect(conn).get_table_names()


def _has_column(conn: sa.Connection, table: str, column: str) -> bool:
    return any(c["name"] == column for c in sa.inspect(conn).get_columns(table))


def upgrade() -> None:
    conn = op.get_bind()

    if _has_table(conn, "milvus_schema_sync") and not _has_table(conn, "content_graph_schema_sync"):
        op.rename_table("milvus_schema_sync", "content_graph_schema_sync")
    elif not _has_table(conn, "content_graph_schema_sync"):
        op.create_table(
            "content_graph_schema_sync",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("collection", sa.String(128), nullable=False, unique=True),
            sa.Column("schema_version", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("last_reset_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_reported_by", sa.String(128), nullable=False, server_default=""),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )

    for table in ("ingestion_items", "ingestion_documents"):
        if (
            _has_table(conn, table)
            and _has_column(conn, table, "milvus_doc_id")
            and not _has_column(conn, table, "graph_node_id")
        ):
            op.alter_column(table, "milvus_doc_id", new_column_name="graph_node_id")


def downgrade() -> None:
    conn = op.get_bind()
    for table in ("ingestion_items", "ingestion_documents"):
        if (
            _has_table(conn, table)
            and _has_column(conn, table, "graph_node_id")
            and not _has_column(conn, table, "milvus_doc_id")
        ):
            op.alter_column(table, "graph_node_id", new_column_name="milvus_doc_id")
    if _has_table(conn, "content_graph_schema_sync") and not _has_table(conn, "milvus_schema_sync"):
        op.rename_table("content_graph_schema_sync", "milvus_schema_sync")
