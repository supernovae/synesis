"""Validation helpers for public model offerings."""

from __future__ import annotations

import pytest

from app.services.public_model_offerings_rules import (
    validate_client_model_id,
    validate_effort_tier,
    effort_to_coder_role,
    effort_to_general_role,
)


def test_validate_client_model_id_ok() -> None:
    assert validate_client_model_id("exp-my-model") == "exp-my-model"


def test_validate_client_model_id_reserved() -> None:
    with pytest.raises(ValueError, match="reserved"):
        validate_client_model_id("pulse")


def test_validate_client_model_id_invalid_char() -> None:
    with pytest.raises(ValueError, match="alphanumeric"):
        validate_client_model_id("bad name")


def test_effort_tier() -> None:
    assert validate_effort_tier("CORE") == "core"
    with pytest.raises(ValueError):
        validate_effort_tier("nope")


def test_effort_roles() -> None:
    assert effort_to_coder_role("pulse") == "coder-pulse"
    assert effort_to_general_role("horizon") == "general-horizon"
