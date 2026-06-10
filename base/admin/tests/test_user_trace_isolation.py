from __future__ import annotations

from app.auth import UserInfo, get_current_user
from app.main import app
from app.services.account_usage_service import account_usage_identity_candidates
from fastapi.testclient import TestClient


def _empty_account_dashboard(since_hours: int) -> dict:
    empty = {
        "source": "total",
        "requests": 0,
        "tokens_in": 0,
        "tokens_out": 0,
        "total_tokens": 0,
        "tokens_cached": 0,
        "tokens_cache_write": 0,
        "price_usd": 0.0,
        "no_cache_price_usd": 0.0,
        "cache_discount_usd": 0.0,
        "avg_latency_ms": 0.0,
        "error_count": 0,
    }
    return {
        "period_hours": since_hours,
        "summary": {
            "chat": {**empty, "source": "chat"},
            "coder": {**empty, "source": "coder"},
            "total": empty,
        },
        "series": [],
        "by_key": [],
        "price_basis": "test",
    }


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

    async def _dashboard(user_ids: list[str], *, since_hours: int):
        assert user_ids == ["u1"]
        return _empty_account_dashboard(since_hours)

    async def _trace_aggregate(**kwargs):
        raise AssertionError("trace fallback should not be called for /usage/me/summary")

    monkeypatch.setattr("app.routers.usage.build_account_usage_dashboard", _dashboard)
    monkeypatch.setattr("app.routers.usage.aggregate_traces_period", _trace_aggregate)
    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        resp = client.get("/api/v1/usage/me/summary?since_hours=24")
        assert resp.status_code == 200
        data = resp.json()
        assert data["source"] == "total"
        assert "actual_cost_usd" not in data
        assert "price_usd" in data
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_usage_me_series_does_not_use_trace_fallback(monkeypatch):
    async def _override_user() -> UserInfo:
        return UserInfo(username="u1", role="user", user_id="u1")

    async def _dashboard(user_ids: list[str], *, since_hours: int):
        assert user_ids == ["u1"]
        return _empty_account_dashboard(since_hours)

    async def _trace_series(**kwargs):
        raise AssertionError("trace fallback should not be called for /usage/me/series")

    monkeypatch.setattr("app.routers.usage.build_account_usage_dashboard", _dashboard)
    monkeypatch.setattr("app.routers.usage.trace_time_series", _trace_series)
    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        resp = client.get("/api/v1/usage/me/series?since_hours=24")
        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_usage_summary_org_admin_uses_price_vocabulary(monkeypatch):
    async def _override_user() -> UserInfo:
        return UserInfo(username="org-admin", role="org_admin", user_id="org-admin", org_id="org-1")

    async def _planner_aggregate(**kwargs):
        return {
            "period_hours": 24,
            "request_count": 2,
            "trace_count": 2,
            "total_tokens": 100,
            "tokens_in": 80,
            "tokens_cached": 20,
            "tokens_cache_write": 5,
            "estimated_cost_usd": 0.12,
            "estimated_no_cache_cost_usd": 0.2,
            "cache_savings_usd": 0.08,
            "actual_cost_usd": 0.03,
            "avg_duration_ms": 11,
            "error_count": 0,
            "source": "planner_usage_log",
        }

    async def _trace_aggregate(**kwargs):
        return {"trace_count": 0}

    monkeypatch.setattr("app.routers.usage.aggregate_planner_usage_period", _planner_aggregate)
    monkeypatch.setattr("app.routers.usage.aggregate_traces_period", _trace_aggregate)
    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        resp = client.get("/api/v1/usage/summary?since_hours=24")
        assert resp.status_code == 200
        data = resp.json()
        assert data["price_usd"] == 0.12
        assert data["no_cache_price_usd"] == 0.2
        assert data["cache_discount_usd"] == 0.08
        assert "actual_cost_usd" not in data
        assert "estimated_cost_usd" not in data
        assert "provider_actual_cost_usd" not in data
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_usage_summary_platform_admin_gets_provider_actual(monkeypatch):
    async def _override_user() -> UserInfo:
        return UserInfo(username="platform", role="platform_admin", user_id="platform", org_id="synesis")

    async def _planner_aggregate(**kwargs):
        return {
            "period_hours": 24,
            "request_count": 1,
            "trace_count": 1,
            "total_tokens": 100,
            "tokens_in": 80,
            "tokens_cached": 20,
            "tokens_cache_write": 5,
            "estimated_cost_usd": 0.12,
            "estimated_no_cache_cost_usd": 0.2,
            "cache_savings_usd": 0.08,
            "actual_cost_usd": 0.03,
            "avg_duration_ms": 11,
            "error_count": 0,
            "source": "planner_usage_log",
        }

    async def _trace_aggregate(**kwargs):
        return {"trace_count": 0}

    monkeypatch.setattr("app.routers.usage.aggregate_planner_usage_period", _planner_aggregate)
    monkeypatch.setattr("app.routers.usage.aggregate_traces_period", _trace_aggregate)
    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        resp = client.get("/api/v1/usage/summary?since_hours=24")
        assert resp.status_code == 200
        data = resp.json()
        assert data["price_usd"] == 0.12
        assert data["provider_actual_cost_usd"] == 0.03
        assert "actual_cost_usd" not in data
        assert "estimated_cost_usd" not in data
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_account_usage_identity_candidates_are_self_scoped_aliases():
    user = UserInfo(
        username="byron",
        role="user",
        user_id="sub-1",
        email="Byron@example.com",
    )

    ids = account_usage_identity_candidates(user, ["bearer-tokenhash", "sub-1"])

    assert ids == ["sub-1", "byron", "Byron@example.com", "byron@example.com", "bearer-tokenhash"]


def test_usage_me_request_detail_rejects_malformed_request_id(monkeypatch):
    async def _override_user() -> UserInfo:
        return UserInfo(username="u1", role="user", user_id="u1")

    async def _request_detail(*args, **kwargs):
        raise AssertionError("usage audit lookup should not run for invalid request ids")

    monkeypatch.setattr("app.routers.usage.get_user_usage_audit_request_for_ids", _request_detail)
    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        resp = client.get("/api/v1/usage/me/requests/req-1%0Arole=admin")
        assert resp.status_code == 422
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_usage_me_dashboard_uses_self_identity_candidates(monkeypatch):
    async def _override_user() -> UserInfo:
        return UserInfo(
            username="byron",
            role="user",
            user_id="sub-1",
            email="byron@example.com",
        )

    async def _dashboard(user_ids: list[str], *, since_hours: int):
        assert since_hours == 24
        assert "sub-1" in user_ids
        assert "byron" in user_ids
        assert "byron@example.com" in user_ids
        empty = {
            "source": "total",
            "requests": 0,
            "tokens_in": 0,
            "tokens_out": 0,
            "total_tokens": 0,
            "tokens_cached": 0,
            "tokens_cache_write": 0,
            "price_usd": 0.0,
            "no_cache_price_usd": 0.0,
            "cache_discount_usd": 0.0,
            "avg_latency_ms": 0.0,
            "error_count": 0,
        }
        return {
            "period_hours": since_hours,
            "summary": {
                "chat": {**empty, "source": "chat"},
                "coder": {**empty, "source": "coder"},
                "total": empty,
            },
            "series": [],
            "by_key": [],
            "price_basis": "test",
        }

    monkeypatch.setattr("app.routers.usage.build_account_usage_dashboard", _dashboard)
    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        resp = client.get("/api/v1/usage/me/dashboard?since_hours=24")
        assert resp.status_code == 200
        assert resp.json()["summary"]["coder"]["source"] == "coder"
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_usage_me_requests_returns_safe_metering_only(monkeypatch):
    async def _override_user() -> UserInfo:
        return UserInfo(username="u1", role="user", user_id="u1")

    async def _audit_rows(
        user_id: str,
        *,
        user_ids: list[str],
        since_hours: int,
        limit: int,
        offset: int,
    ):
        assert user_id == "u1"
        assert user_ids == ["u1"]
        return {
            "since_hours": since_hours,
            "total": 1,
            "offset": offset,
            "limit": limit,
            "requests": [
                {
                    "source": "coder",
                    "request_id": "req-1",
                    "trace_id": "req-1",
                    "created_at": "2026-05-22T00:00:00+00:00",
                    "timestamp": 1,
                    "model": "coder",
                    "provider": "test",
                    "status": "ok",
                    "has_error": False,
                    "latency_ms": 10,
                    "tokens_in": 100,
                    "tokens_out": 20,
                    "tokens_cached": 80,
                    "total_tokens": 120,
                    "price_usd": 0.001,
                    "pricing_source": "manual",
                    "auth_method": "pat",
                    "key_id": "key-1",
                    "key_name": "Dev key",
                    "key_prefix": "syn-test",
                    "billing_breakdown": {
                        "tokens_uncached_input": 20,
                        "tokens_cache_read": 80,
                        "tokens_cache_write": 0,
                        "tokens_output": 20,
                        "input_price_usd": 0.00002,
                        "cache_read_price_usd": 0.000008,
                        "cache_write_price_usd": 0,
                        "output_price_usd": 0.0001,
                        "no_cache_price_usd": 0.0002,
                        "cache_discount_usd": 0.000072,
                        "cache_hit_rate": 0.8,
                    },
                    "privacy_mode": "metering_audit",
                    "redaction_status": "no_text_fields",
                    "training_allowed": False,
                    "raw_text_visible": False,
                }
            ],
        }

    monkeypatch.setattr("app.routers.usage.list_user_usage_audit", _audit_rows)
    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        resp = client.get("/api/v1/usage/me/requests?since_hours=24")
        assert resp.status_code == 200
        body = resp.json()
        row = body["requests"][0]
        assert row["training_allowed"] is False
        assert row["raw_text_visible"] is False
        forbidden = {
            "query_snippet",
            "full_record",
            "spans",
            "prompt_snippet",
            "completion_snippet",
            "diagnostics",
            "actual_cost_usd",
            "effective_cost_usd",
            "estimated_cost_usd",
        }
        assert forbidden.isdisjoint(row.keys())
    finally:
        app.dependency_overrides.pop(get_current_user, None)
