"""Add optional cached prompt input rate to model_costs."""

import sqlalchemy as sa
from alembic import op

revision = "017_mcost_cached_in"
down_revision = "016_mcost_canonical"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "model_costs",
        sa.Column("input_cached_per_million", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("model_costs", "input_cached_per_million")
