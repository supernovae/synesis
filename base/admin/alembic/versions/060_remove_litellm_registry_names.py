"""Rename legacy LiteLLM registry columns to direct route terms.

Revision ID: 060_remove_litellm_routes
Revises: 059_content_pack_installs
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "060_remove_litellm_routes"
down_revision: str | None = "059_content_pack_installs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _has_column(table: str, column: str) -> bool:
    return any(c["name"] == column for c in sa.inspect(op.get_bind()).get_columns(table))


def upgrade() -> None:
    if _has_column("model_deployments", "litellm_params") and not _has_column("model_deployments", "route_params"):
        op.alter_column("model_deployments", "litellm_params", new_column_name="route_params")
    if _has_column("model_deployments", "litellm_model_id") and not _has_column("model_deployments", "route_model_id"):
        op.alter_column("model_deployments", "litellm_model_id", new_column_name="route_model_id")
    if _has_column("provider_configs", "litellm_prefix") and not _has_column("provider_configs", "route_prefix"):
        op.alter_column("provider_configs", "litellm_prefix", new_column_name="route_prefix")

    op.execute(
        sa.text(
            """
            DELETE FROM admin_audit_events
            WHERE lower(action) LIKE '%litellm%'
               OR lower(action) LIKE 'models.reconcile%'
               OR lower(summary) LIKE '%litellm%'
               OR lower(detail::text) LIKE '%litellm%'
            """
        )
    )


def downgrade() -> None:
    if _has_column("provider_configs", "route_prefix") and not _has_column("provider_configs", "litellm_prefix"):
        op.alter_column("provider_configs", "route_prefix", new_column_name="litellm_prefix")
    if _has_column("model_deployments", "route_model_id") and not _has_column("model_deployments", "litellm_model_id"):
        op.alter_column("model_deployments", "route_model_id", new_column_name="litellm_model_id")
    if _has_column("model_deployments", "route_params") and not _has_column("model_deployments", "litellm_params"):
        op.alter_column("model_deployments", "route_params", new_column_name="litellm_params")
