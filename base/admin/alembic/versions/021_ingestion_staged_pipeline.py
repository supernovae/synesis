"""Staged S3 ingestion: ingestion_documents + ingestion_enrich_queue."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "021_ingestion_staged"
down_revision = "020_feedback_openwebui"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ingestion_documents",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False, primary_key=True),
        sa.Column("ingestion_item_id", sa.Integer(), nullable=False),
        sa.Column("doc_key", sa.String(length=64), nullable=False),
        sa.Column("canonical_uri", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False, server_default=""),
        sa.Column("domain", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("handler", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("authority", sa.String(length=32), nullable=False, server_default="vetted"),
        sa.Column("origin_type", sa.String(length=32), nullable=False, server_default="curated"),
        sa.Column("tags", postgresql.ARRAY(sa.String(length=64)), nullable=True),
        sa.Column("config_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("raw_status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("raw_content_hash", sa.String(length=64), nullable=True),
        sa.Column("raw_fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("raw_s3_keys", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("norm_version", sa.String(length=32), nullable=False, server_default="v1"),
        sa.Column("norm_status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("norm_content_hash", sa.String(length=64), nullable=True),
        sa.Column("norm_s3_md_key", sa.Text(), nullable=True),
        sa.Column("norm_s3_meta_key", sa.Text(), nullable=True),
        sa.Column("normalized_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("enrich_status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("milvus_doc_id", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("chunk_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_message", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["ingestion_item_id"], ["ingestion_items.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("doc_key", name="uq_ingestion_documents_doc_key"),
    )
    op.create_index("ix_ingestion_documents_item_id", "ingestion_documents", ["ingestion_item_id"])
    op.create_index("ix_ingestion_documents_canonical_uri", "ingestion_documents", ["canonical_uri"])
    op.create_index("ix_ingestion_documents_raw_norm", "ingestion_documents", ["raw_status", "norm_status"])

    op.create_table(
        "ingestion_enrich_queue",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False, primary_key=True),
        sa.Column("document_id", sa.BigInteger(), nullable=False),
        sa.Column("norm_version", sa.String(length=32), nullable=False, server_default="v1"),
        sa.Column("enrich_version", sa.String(length=32), nullable=False, server_default="v1"),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("worker_id", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=False, server_default=""),
        sa.ForeignKeyConstraint(["document_id"], ["ingestion_documents.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("document_id", "enrich_version", name="uq_ingestion_enrich_doc_version"),
    )
    op.create_index(
        "ix_ingestion_enrich_queue_pending",
        "ingestion_enrich_queue",
        ["status", "priority", "created_at"],
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index("ix_ingestion_enrich_queue_pending", table_name="ingestion_enrich_queue")
    op.drop_table("ingestion_enrich_queue")
    op.drop_index("ix_ingestion_documents_raw_norm", table_name="ingestion_documents")
    op.drop_index("ix_ingestion_documents_canonical_uri", table_name="ingestion_documents")
    op.drop_index("ix_ingestion_documents_item_id", table_name="ingestion_documents")
    op.drop_table("ingestion_documents")
