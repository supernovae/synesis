"""Normalize model_costs profile for canonical pipeline roles.

Revision ID: 016
Revises: 015
"""

from alembic import op

revision = "016_model_costs_canonical_profile"
down_revision = "015_traces_session"
branch_labels = None
depends_on = None

_CANONICAL = ("router", "general", "critic", "coder", "summarizer")


def upgrade() -> None:
    roles = ", ".join(f"'{r}'" for r in _CANONICAL)
    op.execute(
        f"""
        UPDATE model_costs SET profile = ''
        WHERE role IN ({roles})
        """
    )
    op.execute(
        f"""
        DELETE FROM model_costs a
        USING (
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (PARTITION BY role ORDER BY id) AS rn
                FROM model_costs
                WHERE role IN ({roles})
            ) t WHERE rn > 1
        ) d
        WHERE a.id = d.id
        """
    )


def downgrade() -> None:
    pass
