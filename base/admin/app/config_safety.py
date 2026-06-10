"""Fail-closed checks for production-sensitive configuration."""

from __future__ import annotations

import os

_PRODUCTION_VALUES = {"prod", "production"}


def is_production() -> bool:
    return (
        os.getenv("SYNESIS_ENV", "").strip().lower() in _PRODUCTION_VALUES
        or os.getenv("ENVIRONMENT", "").strip().lower() in _PRODUCTION_VALUES
        or os.getenv("NODE_ENV", "").strip().lower() in _PRODUCTION_VALUES
    )


def reject_placeholder_secret(name: str, value: str) -> None:
    normalized = str(value or "").strip().lower()
    if not normalized or "changeme" in normalized or "change-me" in normalized or "replace_me" in normalized:
        raise RuntimeError(f"{name} must be set to a non-placeholder value in production")


def require_production_database_url(name: str, value: str) -> None:
    if is_production():
        reject_placeholder_secret(name, value)
