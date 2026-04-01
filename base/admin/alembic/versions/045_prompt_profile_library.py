"""Prompt profile library for Yarn and Planner services.

Revision ID: 045
Revises: 044
Create Date: 2026-03-31
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "045"
down_revision: str | None = "044"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "prompt_profiles",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("service", sa.String(32), nullable=False, server_default="yarn"),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column("content_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_by", sa.String(256), nullable=False, server_default=""),
        sa.Column("updated_by", sa.String(256), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", name="uq_prompt_profiles_name"),
    )
    op.create_index("ix_prompt_profiles_service", "prompt_profiles", ["service"])
    op.create_index("ix_prompt_profiles_enabled", "prompt_profiles", ["enabled"])

    op.create_table(
        "prompt_assignments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("service", sa.String(32), nullable=False, server_default="yarn"),
        sa.Column("target_type", sa.String(32), nullable=False, server_default="default"),
        sa.Column("target_value", sa.String(128), nullable=False, server_default="*"),
        sa.Column("profile_id", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("updated_by", sa.String(256), nullable=False, server_default=""),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["profile_id"], ["prompt_profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "service",
            "target_type",
            "target_value",
            name="uq_prompt_assignments_service_target",
        ),
    )
    op.create_index("ix_prompt_assignments_service", "prompt_assignments", ["service"])
    op.create_index("ix_prompt_assignments_profile_id", "prompt_assignments", ["profile_id"])


def downgrade() -> None:
    op.drop_table("prompt_assignments")
    op.drop_table("prompt_profiles")
