"""Admin audit event log for operator actions and propagation outcomes."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "018_admin_audit"
down_revision = "017_mcost_cached_in"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "admin_audit_events",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("source", sa.String(32), nullable=False, server_default="api"),
        sa.Column("actor_username", sa.String(256), nullable=False, server_default=""),
        sa.Column("actor_user_id", sa.String(256), nullable=False, server_default=""),
        sa.Column("actor_role", sa.String(64), nullable=False, server_default=""),
        sa.Column("action", sa.String(128), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("detail", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_admin_audit_events_created_at",
        "admin_audit_events",
        ["created_at"],
    )
    op.create_index("ix_admin_audit_events_action", "admin_audit_events", ["action"])


def downgrade() -> None:
    op.drop_index("ix_admin_audit_events_action", table_name="admin_audit_events")
    op.drop_index("ix_admin_audit_events_created_at_desc", table_name="admin_audit_events")
    op.drop_table("admin_audit_events")
