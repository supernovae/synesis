"""Governance constitutions, clauses, and policy definitions.

Adds the admin control plane data model for versioned governance
artifacts and standalone policy rules.

Revision ID: 042
Revises: 041
Create Date: 2026-03-31
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "042"
down_revision = "041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "governance_constitutions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("constitution_id", sa.String(64), nullable=False),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
        sa.Column("scope", sa.String(16), nullable=False, server_default="org"),
        sa.Column("scope_value", sa.String(256), nullable=False, server_default=""),
        sa.Column("precedence", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("provenance_source", sa.String(256), nullable=False, server_default=""),
        sa.Column("provenance_owner", sa.String(256), nullable=False, server_default=""),
        sa.Column("provenance_checksum", sa.String(128), nullable=False, server_default=""),
        sa.Column("effective_from", sa.DateTime(timezone=True), nullable=True),
        sa.Column("effective_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("maturity_mode", sa.String(16), nullable=False, server_default="base"),
        sa.Column("created_by", sa.String(256), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_gov_const_cid", "governance_constitutions", ["constitution_id"])
    op.create_index("ix_gov_const_scope", "governance_constitutions", ["scope", "scope_value"])
    op.create_index("ix_gov_const_status", "governance_constitutions", ["status"])

    op.create_table(
        "governance_clauses",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("clause_id", sa.String(64), nullable=False, unique=True),
        sa.Column("constitution_id", sa.String(64), nullable=False),
        sa.Column("category", sa.String(32), nullable=False, server_default="quality"),
        sa.Column("constraint_kind", sa.String(16), nullable=False, server_default="guiding"),
        sa.Column("statement", sa.Text(), nullable=False, server_default=""),
        sa.Column("machine_rule", JSONB(), nullable=True),
        sa.Column("applicability", JSONB(), nullable=True),
        sa.Column("evidence_requirements", JSONB(), nullable=True),
        sa.Column("actions", JSONB(), nullable=True),
        sa.Column("validation_recipe_id", sa.String(128), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_gov_clause_const", "governance_clauses", ["constitution_id"])

    op.create_table(
        "governance_policy_defs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("policy_id", sa.String(64), nullable=False, unique=True),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("scope", sa.String(16), nullable=False, server_default="org"),
        sa.Column("scope_value", sa.String(256), nullable=False, server_default=""),
        sa.Column("org_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("category", sa.String(32), nullable=False, server_default="quality"),
        sa.Column("constraint_kind", sa.String(16), nullable=False, server_default="guiding"),
        sa.Column("rule_type", sa.String(32), nullable=False, server_default="threshold"),
        sa.Column("rule_config", JSONB(), nullable=False, server_default="{}"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.String(256), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_gov_policy_org", "governance_policy_defs", ["org_id"])
    op.create_index("ix_gov_policy_scope", "governance_policy_defs", ["scope", "scope_value"])


def downgrade() -> None:
    op.drop_table("governance_policy_defs")
    op.drop_table("governance_clauses")
    op.drop_table("governance_constitutions")
