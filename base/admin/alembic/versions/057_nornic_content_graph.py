"""Normalize legacy catalog bookkeeping to the NornicDB content graph.

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


def _legacy_schema_sync_table(conn: sa.Connection) -> str:
    expected = {"id", "collection", "schema_version", "last_reset_at", "last_reported_by", "updated_at"}
    inspector = sa.inspect(conn)
    for table in inspector.get_table_names():
        if table == "content_graph_schema_sync" or not table.endswith("_schema_sync"):
            continue
        columns = {column["name"] for column in inspector.get_columns(table)}
        if expected.issubset(columns):
            return table
    return ""


def _legacy_document_id_column(conn: sa.Connection, table: str) -> str:
    if not _has_table(conn, table):
        return ""
    for column in sa.inspect(conn).get_columns(table):
        name = str(column["name"])
        if name.endswith("_doc_id") and name != "doc_id":
            return name
    return ""


def upgrade() -> None:
    conn = op.get_bind()

    legacy_sync_table = _legacy_schema_sync_table(conn)
    if legacy_sync_table and not _has_table(conn, "content_graph_schema_sync"):
        op.rename_table(legacy_sync_table, "content_graph_schema_sync")
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
        legacy_column = _legacy_document_id_column(conn, table)
        if legacy_column and not _has_column(conn, table, "graph_node_id"):
            op.alter_column(table, legacy_column, new_column_name="graph_node_id")


def downgrade() -> None:
    # Migration 008 now creates the normalized names directly, so the current
    # baseline is also the correct downgrade target.
    return None
