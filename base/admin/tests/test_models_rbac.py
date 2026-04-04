from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.auth import UserInfo, get_current_user
from app.main import app
from fastapi.testclient import TestClient


def _override_user_with_role(role: str) -> Callable[[], UserInfo]:
    async def _override_user() -> UserInfo:
        return UserInfo(username="u1", role=role, user_id="u1")

    return _override_user


def test_models_endpoints_forbid_non_admin() -> None:
    app.dependency_overrides[get_current_user] = _override_user_with_role("user")
    try:
        client = TestClient(app)
        for path in ("/api/v1/models/", "/api/v1/models/roles", "/api/v1/models/costs"):
            resp = client.get(path)
            assert resp.status_code == 403
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_models_endpoints_allow_org_admin(monkeypatch) -> None:
    async def _fake_roles() -> list[dict[str, Any]]:
        return [{"role": "planner", "model": "test-model"}]

    async def _fake_costs() -> list[dict[str, Any]]:
        return [{"role": "planner", "input_per_million": 1.0, "output_per_million": 2.0}]

    monkeypatch.setattr("app.routers.models.get_role_assignments", _fake_roles)
    monkeypatch.setattr("app.routers.models.get_cost_estimates", _fake_costs)

    app.dependency_overrides[get_current_user] = _override_user_with_role("org_admin")
    try:
        client = TestClient(app)
        assert client.get("/api/v1/models/").status_code == 200
        assert client.get("/api/v1/models/roles").status_code == 200
        assert client.get("/api/v1/models/costs").status_code == 200
    finally:
        app.dependency_overrides.pop(get_current_user, None)
