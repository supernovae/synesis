"""Add session and causal columns to traces (conversation, parent, root)."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "015_traces_session"
down_revision = "014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("traces", sa.Column("conversation_id", sa.String(128), nullable=True))
    op.add_column("traces", sa.Column("parent_trace_id", sa.String(64), nullable=True))
    op.add_column("traces", sa.Column("root_trace_id", sa.String(64), nullable=True))
    op.create_index("ix_traces_conversation_id", "traces", ["conversation_id"])
    op.create_index("ix_traces_parent_trace_id", "traces", ["parent_trace_id"])
    op.create_index("ix_traces_root_trace_id", "traces", ["root_trace_id"])


def downgrade() -> None:
    op.drop_index("ix_traces_root_trace_id", table_name="traces")
    op.drop_index("ix_traces_parent_trace_id", table_name="traces")
    op.drop_index("ix_traces_conversation_id", table_name="traces")
    op.drop_column("traces", "root_trace_id")
    op.drop_column("traces", "parent_trace_id")
    op.drop_column("traces", "conversation_id")
