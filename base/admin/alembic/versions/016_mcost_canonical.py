"""Normalize model_costs profile for canonical pipeline roles.

Revision ID must fit alembic_version.version_num (VARCHAR(32)).
"""

from alembic import op

revision = "016_mcost_canonical"
down_revision = "015_traces_session"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Literal SQL (fixed role list) — avoids string-interpolation SQL lint (B608/S608).
    op.execute(
        """
        UPDATE model_costs SET profile = ''
        WHERE role IN ('router', 'general', 'critic', 'coder', 'summarizer')
        """
    )
    op.execute(
        """
        DELETE FROM model_costs a
        USING (
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (PARTITION BY role ORDER BY id) AS rn
                FROM model_costs
                WHERE role IN ('router', 'general', 'critic', 'coder', 'summarizer')
            ) t WHERE rn > 1
        ) d
        WHERE a.id = d.id
        """
    )


def downgrade() -> None:
    pass
