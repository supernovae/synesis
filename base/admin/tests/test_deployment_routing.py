"""Unit tests for canonical provider + registry routing merge.

Run from base/admin/::

    PYTHONPATH=. uv run pytest tests/test_deployment_routing.py -v
"""

from __future__ import annotations

from app.services.model_registry import ProviderGovernanceMaps, resolve_deployment_routing_for_parts


def test_custom_provider_inherits_governance_key_endpoint_prefix() -> None:
    maps = ProviderGovernanceMaps(
        default_endpoints={"acme": "https://api.acme/v1"},
        api_key_envs={"acme": "ACME_API_KEY"},
        route_prefixes={"acme": "openai/"},
    )
    r = resolve_deployment_routing_for_parts(
        provider="acme",
        model="gpt-4",
        endpoint_field="",
        api_key_env_field="",
        stored_route_params=None,
        maps=maps,
        max_tokens=1024,
        temperature=0.2,
    )
    assert r.effective_api_key_env == "ACME_API_KEY"
    assert r.resolved_endpoint == "https://api.acme/v1"
    assert r.route_params["api_key"] == "os.environ/ACME_API_KEY"
    assert r.route_params["api_base"] == "https://api.acme/v1"
    assert r.route_params["model"] == "openai/gpt-4"


def test_governance_route_prefix_overrides_custom_catalog_default() -> None:
    """Unknown provider keys resolve to catalog 'custom' (openai/) unless DB sets a prefix."""
    maps = ProviderGovernanceMaps(
        default_endpoints={"weird": "https://w.example/v1"},
        api_key_envs={"weird": "WEIRD_KEY"},
        route_prefixes={"weird": "vertex_ai/"},
    )
    r = resolve_deployment_routing_for_parts(
        provider="weird",
        model="gemini-pro",
        endpoint_field="",
        api_key_env_field="",
        stored_route_params=None,
        maps=maps,
        max_tokens=512,
        temperature=0.0,
    )
    assert r.route_params["model"] == "vertex_ai/gemini-pro"


def test_role_api_key_env_override_wins_over_governance() -> None:
    maps = ProviderGovernanceMaps(
        default_endpoints={},
        api_key_envs={"openrouter": "OPENROUTER_API_KEY"},
        route_prefixes={},
    )
    r = resolve_deployment_routing_for_parts(
        provider="openrouter",
        model="x/y",
        endpoint_field="",
        api_key_env_field="MY_OPENROUTER",
        stored_route_params=None,
        maps=maps,
        max_tokens=100,
        temperature=0.1,
    )
    assert r.effective_api_key_env == "MY_OPENROUTER"
    assert r.route_params["api_key"] == "os.environ/MY_OPENROUTER"
