"""Add acl_mode and acl_groups to ingestion sources and items.

Revision ID: 034_ingestion_acl_fields
Revises: 033_tenant_observability
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "034_ingestion_acl_fields"
down_revision: str | None = "033_tenant_observability"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ingestion_sources", sa.Column("acl_mode", sa.String(16), nullable=False, server_default="open"))
    op.add_column("ingestion_sources", sa.Column("acl_groups", sa.String(1024), nullable=False, server_default=""))
    op.add_column("ingestion_items", sa.Column("acl_mode", sa.String(16), nullable=False, server_default="open"))
    op.add_column("ingestion_items", sa.Column("acl_groups", sa.String(1024), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("ingestion_items", "acl_groups")
    op.drop_column("ingestion_items", "acl_mode")
    op.drop_column("ingestion_sources", "acl_groups")
    op.drop_column("ingestion_sources", "acl_mode")
