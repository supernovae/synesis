from __future__ import annotations

import pytest
from app.auth import UserInfo, get_current_user
from app.main import app
from app.rbac import require_platform_admin
from app.routers.settings import InfraCostConfigBody
from fastapi.testclient import TestClient
from pydantic import ValidationError


def test_infra_cost_config_accepts_known_payload() -> None:
    body = InfraCostConfigBody(
        cloud="aws",
        instance_type="p5.48xlarge",
        gpu_model="H100",
        gpu_count=8,
        hourly_rate=98.32,
        tokens_per_hour=600_000_000,
        notes="production serving pool",
    )

    assert body.model_dump() == {
        "cloud": "aws",
        "instance_type": "p5.48xlarge",
        "gpu_model": "H100",
        "gpu_count": 8,
        "hourly_rate": 98.32,
        "tokens_per_hour": 600_000_000,
        "notes": "production serving pool",
    }


def test_infra_cost_config_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError, match="admin_override"):
        InfraCostConfigBody(
            cloud="aws",
            hourly_rate=98.32,
            tokens_per_hour=600_000_000,
            admin_override=True,
        )


def test_infra_cost_config_rejects_negative_hourly_rate() -> None:
    with pytest.raises(ValidationError, match="hourly_rate"):
        InfraCostConfigBody(hourly_rate=-1.0)


def test_infra_cost_role_routes_reject_unknown_or_malformed_roles() -> None:
    async def _platform_admin() -> UserInfo:
        return UserInfo(username="admin", role="platform_admin", user_id="admin")

    app.dependency_overrides[get_current_user] = _platform_admin
    app.dependency_overrides[require_platform_admin] = _platform_admin
    try:
        client = TestClient(app)
        payload = {"cloud": "aws", "hourly_rate": 1.0, "tokens_per_hour": 1000}

        unknown = client.put("/api/v1/settings/infra-costs/platform_admin", json=payload)
        assert unknown.status_code == 404
        assert "Unknown role" in unknown.text

        malformed = client.put("/api/v1/settings/infra-costs/coder-core%0Arole=admin", json=payload)
        assert malformed.status_code == 422
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(require_platform_admin, None)
