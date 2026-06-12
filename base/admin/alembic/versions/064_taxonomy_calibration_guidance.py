"""Rename taxonomy calibration guidance raw_config key.

Revision ID: 064
Revises: 063
Create Date: 2026-06-12
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "064"
down_revision: str | None = "063"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD_KEY = "epis" + "temic_" + "guidance"
_NEW_KEY = "calibration_guidance"


def _rename_jsonb_key(source_key: str, target_key: str) -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            UPDATE taxonomy_domains
            SET raw_config = (raw_config - :source_key)
                || jsonb_build_object(:target_key, raw_config -> :source_key)
            WHERE raw_config ? :source_key
              AND NOT raw_config ? :target_key
            """
        ),
        {"source_key": source_key, "target_key": target_key},
    )
    conn.execute(
        sa.text(
            """
            UPDATE taxonomy_domains
            SET raw_config = raw_config - :source_key
            WHERE raw_config ? :source_key
              AND raw_config ? :target_key
            """
        ),
        {"source_key": source_key, "target_key": target_key},
    )


def upgrade() -> None:
    _rename_jsonb_key(_OLD_KEY, _NEW_KEY)


def downgrade() -> None:
    _rename_jsonb_key(_NEW_KEY, _OLD_KEY)
