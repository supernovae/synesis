"""Role-first model registry: add provider/api_key_env, history table, new indexes.

Drops the environment-based unique index in favour of a partial unique on
(role) WHERE is_active = true so each role has at most one active assignment.

Revision ID: 014
Revises: 013
Create Date: 2026-03-20

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "014"
down_revision: str | None = "013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PROVIDER_FROM_SOURCE = {
    "openrouter": "openrouter",
    "vllm": "vllm",
    "kserve": "kserve",
    "external": "custom",
    "local": "vllm",
}


def upgrade() -> None:
    # -- model_deployments: new columns --
    op.add_column("model_deployments", sa.Column("provider", sa.String(32), nullable=True))
    op.add_column("model_deployments", sa.Column("api_key_env", sa.String(128), nullable=True))

    # Populate provider from existing source column
    conn = op.get_bind()
    for old, new in PROVIDER_FROM_SOURCE.items():
        conn.execute(
            sa.text("UPDATE model_deployments SET provider = :new WHERE source = :old AND provider IS NULL"),
            {"new": new, "old": old},
        )
    # Catch any remaining NULLs
    conn.execute(sa.text("UPDATE model_deployments SET provider = source WHERE provider IS NULL"))

    # -- model_deployments: index changes --
    op.drop_index("ix_model_deployments_env_role", table_name="model_deployments")
    op.create_index(
        "ix_model_deployments_active_role",
        "model_deployments",
        ["role"],
        unique=True,
        postgresql_where=sa.text("is_active = true"),
    )

    # -- model_role_history --
    op.create_table(
        "model_role_history",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("role", sa.String(64), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("model", sa.String(256), nullable=False),
        sa.Column("endpoint", sa.Text, nullable=False, server_default=""),
        sa.Column("input_per_million", sa.Float, nullable=False, server_default="0"),
        sa.Column("output_per_million", sa.Float, nullable=False, server_default="0"),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_model_role_history_role", "model_role_history", ["role"])
    op.create_index(
        "ix_model_role_history_deactivated",
        "model_role_history",
        [sa.text("deactivated_at DESC NULLS FIRST")],
    )


def downgrade() -> None:
    op.drop_table("model_role_history")
    op.drop_index("ix_model_deployments_active_role", table_name="model_deployments")
    op.create_index(
        "ix_model_deployments_env_role",
        "model_deployments",
        ["environment", "role"],
        unique=True,
    )
    op.drop_column("model_deployments", "api_key_env")
    op.drop_column("model_deployments", "provider")
