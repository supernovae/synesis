"""Add multi-tenant scope fields to ingestion sources, items, and documents.

Three-tier visibility model: global / org / tenant.

Revision ID: 030_ingestion_tenant_scope
Revises: 029_model_policies
Create Date: 2026-03-23
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "030_ingestion_tenant_scope"
down_revision: str | None = "029_model_policies"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("ingestion_sources", sa.Column("visibility_scope", sa.String(16), nullable=False, server_default="global"))
    op.add_column("ingestion_sources", sa.Column("org_id", sa.String(64), nullable=False, server_default=""))
    op.add_column("ingestion_sources", sa.Column("tenant_id", sa.String(64), nullable=False, server_default=""))
    op.create_index("ix_ingestion_sources_org_id", "ingestion_sources", ["org_id"])

    op.add_column("ingestion_items", sa.Column("visibility_scope", sa.String(16), nullable=False, server_default="global"))
    op.add_column("ingestion_items", sa.Column("org_id", sa.String(64), nullable=False, server_default=""))
    op.add_column("ingestion_items", sa.Column("tenant_id", sa.String(64), nullable=False, server_default=""))
    op.create_index("ix_ingestion_items_org_id", "ingestion_items", ["org_id"])

    op.add_column("ingestion_documents", sa.Column("visibility_scope", sa.String(16), nullable=False, server_default="global"))
    op.add_column("ingestion_documents", sa.Column("org_id", sa.String(64), nullable=False, server_default=""))
    op.add_column("ingestion_documents", sa.Column("tenant_id", sa.String(64), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("ingestion_documents", "tenant_id")
    op.drop_column("ingestion_documents", "org_id")
    op.drop_column("ingestion_documents", "visibility_scope")

    op.drop_index("ix_ingestion_items_org_id", table_name="ingestion_items")
    op.drop_column("ingestion_items", "tenant_id")
    op.drop_column("ingestion_items", "org_id")
    op.drop_column("ingestion_items", "visibility_scope")

    op.drop_index("ix_ingestion_sources_org_id", table_name="ingestion_sources")
    op.drop_column("ingestion_sources", "tenant_id")
    op.drop_column("ingestion_sources", "org_id")
    op.drop_column("ingestion_sources", "visibility_scope")
