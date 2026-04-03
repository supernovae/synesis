from __future__ import annotations

from fastapi.testclient import TestClient

from app.auth import UserInfo, get_current_user
from app.main import app


def test_quality_wiring_forbidden_for_user():
    async def _override_user() -> UserInfo:
        return UserInfo(username="u1", role="user", user_id="u1")

    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        resp = client.get("/api/v1/dashboard/quality-wiring")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_usage_me_summary_does_not_use_trace_fallback(monkeypatch):
    async def _override_user() -> UserInfo:
        return UserInfo(username="u1", role="user", user_id="u1")

    async def _planner_usage(*, since_hours: int, scope_user_id: str, scope_org_id: str, scope_tenant_id: str):
        return {
            "period_hours": since_hours,
            "request_count": 0,
            "trace_count": 0,
            "total_tokens": 0,
            "estimated_cost_usd": 0.0,
            "actual_cost_usd": 0.0,
            "avg_duration_ms": 0.0,
            "error_count": 0,
            "source": "planner_usage_log",
        }

    async def _trace_aggregate(**kwargs):
        raise AssertionError("trace fallback should not be called for /usage/me/summary")

    monkeypatch.setattr("app.routers.usage.aggregate_planner_usage_period", _planner_usage)
    monkeypatch.setattr("app.routers.usage.aggregate_traces_period", _trace_aggregate)
    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        resp = client.get("/api/v1/usage/me/summary?since_hours=24")
        assert resp.status_code == 200
        data = resp.json()
        assert data["source"] == "planner_usage_log"
        assert data.get("note") is None
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_usage_me_series_does_not_use_trace_fallback(monkeypatch):
    async def _override_user() -> UserInfo:
        return UserInfo(username="u1", role="user", user_id="u1")

    async def _planner_series(*, since_hours: int, scope_user_id: str, scope_org_id: str, scope_tenant_id: str):
        return []

    async def _trace_series(**kwargs):
        raise AssertionError("trace fallback should not be called for /usage/me/series")

    monkeypatch.setattr("app.routers.usage.planner_usage_time_series", _planner_series)
    monkeypatch.setattr("app.routers.usage.trace_time_series", _trace_series)
    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        resp = client.get("/api/v1/usage/me/series?since_hours=24")
        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.pop(get_current_user, None)
