"""ACL group management for per-document authorization.

Revision ID: 032_acl_groups
Revises: 031_pat_tenant_ids
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "032_acl_groups"
down_revision: str | None = "031_pat_tenant_ids"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "acl_groups",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("group_id", sa.String(64), nullable=False),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("org_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("source", sa.String(32), nullable=False, server_default="admin"),
        sa.Column("keycloak_group_path", sa.String(512), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("group_id"),
    )
    op.create_index("ix_acl_groups_org_id", "acl_groups", ["org_id"])

    op.create_table(
        "acl_group_members",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("group_id", sa.String(64), nullable=False),
        sa.Column("user_id", sa.String(256), nullable=False),
        sa.Column("granted_by", sa.String(256), nullable=False, server_default=""),
        sa.Column("granted_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("group_id", "user_id", name="uq_acl_group_member"),
    )
    op.create_index("ix_acl_group_members_user_id", "acl_group_members", ["user_id"])
    op.create_index("ix_acl_group_members_group_id", "acl_group_members", ["group_id"])

    op.create_table(
        "acl_policies",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("org_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("scope", sa.String(32), nullable=False, server_default="org"),
        sa.Column("target_type", sa.String(32), nullable=False, server_default="content"),
        sa.Column("acl_groups", sa.ARRAY(sa.String(64)), nullable=True),
        sa.Column("route_groups", sa.ARRAY(sa.String(64)), nullable=True),
        sa.Column("effect", sa.String(16), nullable=False, server_default="allow"),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.String(256), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_acl_policies_org_id", "acl_policies", ["org_id"])


def downgrade() -> None:
    op.drop_table("acl_policies")
    op.drop_table("acl_group_members")
    op.drop_table("acl_groups")
