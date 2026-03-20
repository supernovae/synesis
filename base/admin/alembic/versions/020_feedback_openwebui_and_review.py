"""Open WebUI feedback mirror + triage workspace (review status / internal notes)."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "020_feedback_openwebui"
down_revision = "019_ingestion_indexer_stats"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "openwebui_feedback",
        sa.Column("owui_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=256), nullable=False, server_default=""),
        sa.Column("feedback_type", sa.String(length=128), nullable=False, server_default=""),
        sa.Column(
            "data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "meta",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "snapshot",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("created_at_epoch", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("updated_at_epoch", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("ingested_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("owui_id"),
    )
    op.create_index("ix_openwebui_feedback_created", "openwebui_feedback", ["created_at_epoch"])

    op.create_table(
        "feedback_review",
        sa.Column("subject_key", sa.String(length=512), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("internal_note", sa.Text(), nullable=False, server_default=""),
        sa.Column("updated_by", sa.String(length=256), nullable=False, server_default=""),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("subject_key"),
    )


def downgrade() -> None:
    op.drop_table("feedback_review")
    op.drop_index("ix_openwebui_feedback_created", table_name="openwebui_feedback")
    op.drop_table("openwebui_feedback")
