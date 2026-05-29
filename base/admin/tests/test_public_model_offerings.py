"""Validation helpers for public model offerings."""

from __future__ import annotations

import pytest
from app.services.public_model_offerings_rules import (
    effort_to_coder_role,
    effort_to_writer_role,
    normalize_generation_params,
    normalize_offering_connection,
    validate_client_model_id,
    validate_connection_mode,
    validate_effort_tier,
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
    assert effort_to_writer_role("horizon") == "writer-horizon"


def test_connection_mode_validation() -> None:
    assert validate_connection_mode("standalone") == "standalone"
    assert validate_connection_mode("ROLE_CLONE") == "role_clone"
    with pytest.raises(ValueError, match="connection_mode"):
        validate_connection_mode("bad")


def test_normalize_offering_connection_role_clone() -> None:
    effort, route, mode, provider, endpoint, api_key_env = normalize_offering_connection(
        effort_tier="core",
        route_via_role=None,
        connection_mode="role_clone",
        standalone_provider="openrouter",
        standalone_endpoint="https://example.com",
        standalone_api_key_env="OPENROUTER_API_KEY",
        expose_yarn=True,
    )
    assert effort == "core"
    assert route == "coder-core"
    assert mode == "role_clone"
    assert provider is None
    assert endpoint is None
    assert api_key_env is None


def test_normalize_offering_connection_standalone_yarn_required_fields() -> None:
    with pytest.raises(ValueError, match="standalone_provider"):
        normalize_offering_connection(
            effort_tier="core",
            route_via_role=None,
            connection_mode="standalone",
            standalone_provider="",
            standalone_endpoint="https://example.com/v1",
            standalone_api_key_env="OPENROUTER_API_KEY",
            expose_yarn=True,
        )


def test_normalize_offering_connection_standalone_ok() -> None:
    effort, route, mode, provider, endpoint, api_key_env = normalize_offering_connection(
        effort_tier="horizon",
        route_via_role=None,
        connection_mode="standalone",
        standalone_provider="openrouter",
        standalone_endpoint="https://example.com/v1",
        standalone_api_key_env="OPENROUTER_API_KEY",
        expose_yarn=True,
    )
    assert effort == "horizon"
    assert route is None
    assert mode == "standalone"
    assert provider == "openrouter"
    assert endpoint == "https://example.com/v1"
    assert api_key_env == "OPENROUTER_API_KEY"


def test_normalize_generation_params() -> None:
    assert normalize_generation_params(
        {
            "max_tokens": "2048",
            "temperature": "0.1",
            "top_k": 20,
            "enable_thinking": False,
            "reasoning_effort": "low",
            "model_capability_preset": "deepseek-v4",
            "ignored": "value",
        }
    ) == {
        "max_tokens": 2048,
        "temperature": 0.1,
        "top_k": 20,
        "enable_thinking": False,
        "reasoning_effort": "low",
        "model_capability_preset": "deepseek_v4",
    }


def test_normalize_generation_params_rejects_invalid_boolean() -> None:
    with pytest.raises(ValueError, match="enable_thinking"):
        normalize_generation_params({"enable_thinking": "false"})


def test_normalize_generation_params_rejects_invalid_model_capability_preset() -> None:
    with pytest.raises(ValueError, match="model_capability_preset"):
        normalize_generation_params({"model_capability_preset": "custom_freeform"})
