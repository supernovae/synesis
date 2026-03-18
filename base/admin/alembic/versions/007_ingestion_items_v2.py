"""Extend ingestion_items: rename url->uri, add handler/config/authority/origin_type/content_hash/retry columns.

Revision ID: 007
Revises: 006
Create Date: 2026-03-18

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "007"
down_revision: str | None = "006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    cols = {c["name"] for c in sa.inspect(conn).get_columns("ingestion_items")}

    if "url" in cols and "uri" not in cols:
        op.alter_column("ingestion_items", "url", new_column_name="uri")

    if "uri" not in cols and "url" not in cols:
        op.add_column("ingestion_items", sa.Column("uri", sa.Text(), nullable=False, server_default=""))

    uri_col = "uri" if "uri" in cols or "url" in cols else "uri"
    try:
        op.create_index("ix_ingestion_items_uri_unique", "ingestion_items", [uri_col], unique=True)
    except Exception:
        pass

    new_cols = [
        ("handler", sa.String(64), True, None),
        ("config", JSONB(), True, None),
        ("authority", sa.String(32), False, "vetted"),
        ("origin_type", sa.String(32), False, "curated"),
        ("content_hash", sa.String(64), True, None),
        ("retry_count", sa.Integer(), False, "0"),
        ("max_retries", sa.Integer(), False, "3"),
    ]
    for name, col_type, nullable, default in new_cols:
        if name not in cols:
            kw: dict = {"nullable": nullable}
            if default is not None:
                kw["server_default"] = default
            op.add_column("ingestion_items", sa.Column(name, col_type, **kw))

    try:
        op.create_index("ix_ingestion_items_handler", "ingestion_items", ["handler"])
    except Exception:
        pass


def downgrade() -> None:
    op.drop_index("ix_ingestion_items_handler", table_name="ingestion_items")
    op.drop_index("ix_ingestion_items_uri_unique", table_name="ingestion_items")
    for col in ("max_retries", "retry_count", "content_hash", "origin_type", "authority", "config", "handler"):
        op.drop_column("ingestion_items", col)
    op.alter_column("ingestion_items", "uri", new_column_name="url")
