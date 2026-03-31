"""Merge DevHub/conformance branch with main migration chain.

Revision ID: 044
Revises: 043, 024_conformance_rollups
Create Date: 2026-03-31
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op  # noqa: F401

revision: str = "044"
down_revision: tuple[str, ...] = ("043", "024_conformance_rollups")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
