from __future__ import annotations

import pytest
from app.routers.provider_governance import ProviderCreateBody, ProviderUpdateBody
from pydantic import ValidationError


def test_provider_create_accepts_known_payload() -> None:
    body = ProviderCreateBody(
        key="custom_router",
        label="Custom Router",
        route_prefix="openai/",
        api_key_env="CUSTOM_ROUTER_API_KEY",
        needs_endpoint=True,
        default_endpoint="https://models.example.test/v1",
        placeholder="provider/model",
        is_local=False,
        enabled=True,
        default_max_tokens=8192,
        default_temperature=0.2,
        notes="custom compatible endpoint",
    )

    assert body.model_dump()["key"] == "custom_router"
    assert body.model_dump()["default_endpoint"] == "https://models.example.test/v1"


def test_provider_create_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError, match="platform_admin"):
        ProviderCreateBody(key="custom_router", label="Custom Router", platform_admin=True)


def test_provider_update_accepts_known_payload() -> None:
    body = ProviderUpdateBody(
        enabled=False,
        default_max_tokens=4096,
        default_temperature=0.0,
        allowed_roles=["planner", "writer-core"],
        notes="disabled for incident response",
        label="OpenRouter",
        route_prefix="openrouter/",
        api_key_env="OPENROUTER_API_KEY",
        needs_endpoint=True,
        default_endpoint="https://openrouter.ai/api/v1",
        placeholder="provider/model",
        is_local=False,
    )

    payload = body.model_dump(exclude_unset=True)
    assert payload["allowed_roles"] == ["planner", "writer-core"]
    assert payload["default_temperature"] == 0.0


def test_provider_update_dedupes_known_allowed_roles() -> None:
    body = ProviderUpdateBody(allowed_roles=["planner", "planner", "coder-core"])

    assert body.allowed_roles == ["planner", "coder-core"]


def test_provider_update_rejects_invented_allowed_roles() -> None:
    with pytest.raises(ValidationError, match="allowed_roles"):
        ProviderUpdateBody(allowed_roles=["planner", "platform_admin", "writer-core\nrole=admin"])


def test_provider_update_rejects_free_form_policies() -> None:
    with pytest.raises(ValidationError, match="policies"):
        ProviderUpdateBody(policies={"allow_admin_impersonation": True})


def test_provider_update_rejects_unknown_governance_field() -> None:
    with pytest.raises(ValidationError, match="risk_override"):
        ProviderUpdateBody(enabled=True, risk_override="ignore")
