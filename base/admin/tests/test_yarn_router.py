"""Tests for Yarn Ops API (`/api/v1/yarn/*`).

Mocks the Yarn service layer and auth so tests run without Postgres or Yarn.
Yarn routes use ``app.dependency_overrides`` (restored after each test) so this file
does not fight the ``monkeypatch`` of ``app.auth.get_current_user`` in ``test_quality_smoke``.
When running a subset of modules together, list ``test_quality_smoke.py`` before this file
so patches apply before ``app`` first imports the routers.

Run from ``base/admin/``::

    PYTHONPATH=. uv run pytest tests/test_yarn_router.py -v
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient

# Per-test user for Yarn routes. Combined with ``app.dependency_overrides`` so this file
# coexists with other tests that patch ``app.auth.get_current_user`` before ``app`` loads.
_auth_ctx: dict[str, object] = {"user": None}


async def _override_yarn_get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = None,
):
    from app.auth import UserInfo

    u = _auth_ctx["user"]
    assert isinstance(u, UserInfo)
    return u


async def _override_require_org_admin():
    from app.auth import UserInfo
    from app.rbac import Role, resolve_role

    u = _auth_ctx["user"]
    assert isinstance(u, UserInfo)
    if resolve_role(u) < Role.org_admin:
        raise HTTPException(
            status_code=403,
            detail="Requires org_admin role or higher",
        )
    return u


async def _override_require_platform_admin():
    from app.auth import UserInfo
    from app.rbac import Role, resolve_role

    u = _auth_ctx["user"]
    assert isinstance(u, UserInfo)
    if resolve_role(u) < Role.platform_admin:
        raise HTTPException(
            status_code=403,
            detail="Requires platform_admin role",
        )
    return u


def _user(*, role: str, user_id: str = "test-user", username: str = "test-user"):
    from app.auth import UserInfo

    return UserInfo(
        user_id=user_id,
        username=username,
        email=f"{username}@test.local",
        role=role,
        org_id="",
        org_name="",
        org_roles=[],
    )


def _org_admin():
    return _user(role="org_admin")


class _FakeScalar:
    def __init__(self, val=None):
        self._val = val

    def scalar_one(self):
        return self._val or 0

    def scalar_one_or_none(self):
        return self._val

    def scalar(self):
        return self._val or 0

    def scalars(self):
        return self

    def all(self):
        return []

    def first(self):
        return None

    def one(self):
        return MagicMock(cnt=0)


class _FakeSession:
    async def execute(self, *a, **kw):
        return _FakeScalar()

    async def commit(self):
        pass

    def add(self, obj):
        pass

    def add_all(self, objs):
        pass

    async def rollback(self):
        pass


@asynccontextmanager
async def _fake_async_session():
    yield _FakeSession()


@pytest.fixture(autouse=True)
def _yarn_router_env(monkeypatch):
    """Avoid lifespan / background tasks touching a real DB; default to org admin."""
    monkeypatch.setattr("app.db.engine.async_session", _fake_async_session)
    _auth_ctx["user"] = _org_admin()


@pytest.fixture()
def client():
    import app.routers.yarn as yarn_mod
    from app.main import app
    from app.rbac import require_org_admin, require_platform_admin

    prev_org = app.dependency_overrides.get(require_org_admin)
    prev_platform = app.dependency_overrides.get(require_platform_admin)
    prev_yarn_user = app.dependency_overrides.get(yarn_mod.get_current_user)
    app.dependency_overrides[require_org_admin] = _override_require_org_admin
    app.dependency_overrides[require_platform_admin] = _override_require_platform_admin
    app.dependency_overrides[yarn_mod.get_current_user] = _override_yarn_get_current_user
    try:
        yield TestClient(app, raise_server_exceptions=True)
    finally:
        if prev_org is None:
            app.dependency_overrides.pop(require_org_admin, None)
        else:
            app.dependency_overrides[require_org_admin] = prev_org
        if prev_platform is None:
            app.dependency_overrides.pop(require_platform_admin, None)
        else:
            app.dependency_overrides[require_platform_admin] = prev_platform
        if prev_yarn_user is None:
            app.dependency_overrides.pop(yarn_mod.get_current_user, None)
        else:
            app.dependency_overrides[yarn_mod.get_current_user] = prev_yarn_user


@pytest.fixture()
def overview_payload():
    return {
        "since_hours": 24,
        "total_requests": 100,
        "total_tokens_in": 10,
        "total_tokens_out": 20,
        "total_tokens_cached": 5,
        "total_cost_usd": 0.01,
        "avg_latency_ms": 120.0,
        "p99_latency_ms": 500.0,
        "error_count": 3,
        "error_rate": 0.03,
        "escalation_count": 1,
        "total_tool_calls": 4,
        "active_sessions": 2,
    }


def test_yarn_overview_returns_expected_fields(client, monkeypatch, overview_payload):
    monkeypatch.setattr(
        "app.services.yarn_service.get_yarn_overview",
        AsyncMock(return_value=overview_payload),
    )
    resp = client.get("/api/v1/yarn/overview?since_hours=24")
    assert resp.status_code == 200
    data = resp.json()
    for key in (
        "total_requests",
        "error_count",
        "error_rate",
        "total_tokens_in",
        "total_tokens_out",
        "active_sessions",
    ):
        assert key in data
    assert data["total_requests"] == 100
    assert data["error_count"] == 3


def test_yarn_intelligence_includes_staff_kpis(client, monkeypatch):
    payload = {
        "since_hours": 24,
        "requests": 10,
        "avg_tool_calls_per_request": 2.2,
        "cache_hit_estimate": 0.1,
        "tool_use_stop_rate": 0.2,
        "error_like_rate": 0.1,
        "trajectory_events": 8,
        "first_pass_verify_rate": 0.6,
        "verification_stall_rate": 0.1,
        "blind_retry_rate": 0.2,
        "patch_ratio": 0.75,
        "structured_error_coverage": 0.5,
        "completion_gate_blocked_rate": 0.15,
        "critic_block_rate": 0.05,
        "trajectory_bucket_counts": {"micro": 4, "repo": 3, "feature": 1},
        "state_transition_quality": {
            "trajectory_events": 8,
            "score_avg": 0.21,
            "label_rates": {
                "forward_progress": 0.5,
                "stalled": 0.25,
                "regressed": 0.2,
                "reground_required": 0.05,
            },
            "label_counts": {
                "forward_progress": 4,
                "stalled": 2,
                "regressed": 1,
                "reground_required": 1,
            },
            "threshold_band_avg": {"forward_progress_min": 0.23, "regressed_max": -0.39},
            "global_scope_counts": {"org_model": 5, "model": 2, "none": 1},
            "global_scope_coverage": 0.875,
            "calibration_events": {
                "local": 2,
                "global": 1,
                "latest_local_at": "2026-04-22T12:00:00+00:00",
                "latest_global_at": "2026-04-22T11:58:00+00:00",
            },
            "top_reasons": [{"reason": "stale_files_increased", "count": 3}],
            "risk_flags": ["high_regressed_rate"],
        },
        "top_models": [],
        "finish_reason_counts": {"stop": 7, "tool_use": 3},
    }
    mock_intel = AsyncMock(return_value=payload)
    monkeypatch.setattr("app.services.yarn_service.get_yarn_intelligence", mock_intel)

    resp = client.get("/api/v1/yarn/intelligence?since_hours=24")
    assert resp.status_code == 200
    data = resp.json()

    for key in (
        "first_pass_verify_rate",
        "verification_stall_rate",
        "blind_retry_rate",
        "patch_ratio",
        "structured_error_coverage",
        "completion_gate_blocked_rate",
        "critic_block_rate",
        "trajectory_bucket_counts",
        "state_transition_quality",
    ):
        assert key in data

    assert data["completion_gate_blocked_rate"] == 0.15
    assert data["critic_block_rate"] == 0.05
    assert data["trajectory_bucket_counts"]["micro"] == 4
    assert data["state_transition_quality"]["label_counts"]["forward_progress"] == 4

    mock_intel.assert_awaited_once()


def test_yarn_sessions_list_paginated_shape(client, monkeypatch):
    payload = {
        "sessions": [
            {
                "id": 1,
                "session_key": "sk-1",
                "user_id": "u1",
                "username": "alice",
                "role": "user",
                "conversation_id": "c1",
                "provider": "openai",
                "model": "gpt-4",
                "total_tokens_in": 1,
                "total_tokens_out": 2,
                "total_tokens_cached": 0,
                "total_cost_usd": 0.001,
                "request_count": 5,
                "escalation_count": 0,
                "created_at": "2025-01-01T00:00:00+00:00",
                "last_active_at": "2025-01-02T00:00:00+00:00",
            }
        ],
        "total": 42,
    }
    mock_list = AsyncMock(return_value=payload)
    monkeypatch.setattr("app.services.yarn_service.list_yarn_sessions", mock_list)
    resp = client.get("/api/v1/yarn/sessions?page=1&page_size=20")
    assert resp.status_code == 200
    body = resp.json()
    assert body == payload
    assert "sessions" in body and isinstance(body["sessions"], list)
    assert body["total"] == 42
    mock_list.assert_awaited_once()
    kw = mock_list.await_args.kwargs
    assert kw["page"] == 1 and kw["page_size"] == 20


def test_yarn_session_detail_unknown_returns_404(client, monkeypatch):
    monkeypatch.setattr(
        "app.services.yarn_service.get_yarn_session_detail",
        AsyncMock(return_value=None),
    )
    resp = client.get("/api/v1/yarn/sessions/unknown-session-key")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Session not found"


def test_yarn_events_passes_errors_only_filter(client, monkeypatch):
    mock_events = AsyncMock(return_value={"events": [], "total": 0})
    monkeypatch.setattr("app.services.yarn_service.list_yarn_events", mock_events)
    resp = client.get(
        "/api/v1/yarn/events?page=1&since_hours=24&errors_only=true",
    )
    assert resp.status_code == 200
    assert resp.json() == {"events": [], "total": 0}
    mock_events.assert_awaited_once()
    assert mock_events.await_args.kwargs["errors_only"] is True
    assert mock_events.await_args.kwargs["since_hours"] == 24


def test_yarn_performance_returns_buckets(client, monkeypatch):
    buckets = [
        {
            "bucket": "2025-03-20T12:00:00+00:00",
            "requests": 10,
            "tokens_in": 100,
            "tokens_out": 200,
            "tokens_cached": 0,
            "cost_usd": 0.05,
            "avg_latency_ms": 80.0,
            "max_latency_ms": 200.0,
            "escalations": 0,
            "errors": 1,
        }
    ]
    monkeypatch.setattr(
        "app.services.yarn_service.get_yarn_performance",
        AsyncMock(return_value=buckets),
    )
    resp = client.get("/api/v1/yarn/performance?since_hours=24&bucket_minutes=15")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]["bucket"] == buckets[0]["bucket"]
    assert data[0]["requests"] == 10


def test_yarn_transition_quality_returns_telemetry(client, monkeypatch):
    payload = {
        "since_hours": 168,
        "bucket_minutes": 60,
        "summary": {
            "bucket_count": 2,
            "trajectory_events_total": 20,
            "quality_score_avg": 0.12,
            "regressed_rate_avg": 0.1,
            "reground_required_rate_avg": 0.05,
            "global_scope_coverage_avg": 0.8,
            "quality_forward_min_avg": 0.25,
            "quality_regressed_max_avg": -0.35,
            "local_calibration_events_total": 3,
            "global_calibration_events_total": 1,
            "risk_flags": ["high_regressed_rate"],
        },
        "alert_thresholds": {
            "regressed_rate_warn": 0.15,
            "reground_required_rate_warn": 0.08,
            "global_scope_coverage_warn": 0.5,
            "quality_score_warn": 0.0,
        },
        "top_quality_reasons": [{"reason": "stale_files_increased", "count": 2}],
        "alert_buckets": [],
        "actions": ["Prioritize regressed trajectories in event drilldown and validate recovery prompt quality."],
        "buckets": [],
    }
    mock_transition = AsyncMock(return_value=payload)
    monkeypatch.setattr(
        "app.services.yarn_service.get_yarn_transition_quality_series",
        mock_transition,
    )
    resp = client.get("/api/v1/yarn/transition-quality?since_hours=168&bucket_minutes=60")
    assert resp.status_code == 200
    data = resp.json()
    assert data == payload
    mock_transition.assert_awaited_once()
    kwargs = mock_transition.await_args.kwargs
    assert kwargs["since_hours"] == 168
    assert kwargs["bucket_minutes"] == 60


def test_yarn_transition_events_returns_tail(client, monkeypatch):
    payload = {
        "since_minutes": 60,
        "event_kinds": ["request_trajectory_v1", "state_transition_v1"],
        "risk_only": True,
        "include_metadata": False,
        "count": 1,
        "session_count": 1,
        "request_count": 1,
        "counts_by_kind": {"state_transition_v1": 1},
        "next_after_id": 1234,
        "events": [
            {
                "id": 1234,
                "session_key": "synesis:u1:coder:conv-1",
                "request_id": "req-1",
                "event_kind": "state_transition_v1",
                "component": "governor",
                "detail": "transition",
                "created_at": "2026-04-22T13:00:00+00:00",
                "quality_label": "regressed",
                "quality_score": -0.2,
                "global_scope": "org_model",
                "reasons": ["stale_files_increased"],
                "risk_flags": ["quality_label_regressed"],
                "calibration_sample_count": 12,
            }
        ],
    }
    mock_tail = AsyncMock(return_value=payload)
    monkeypatch.setattr("app.services.yarn_service.get_yarn_transition_events", mock_tail)

    resp = client.get(
        "/api/v1/yarn/transition-events?since_minutes=60&limit=100&after_id=7&risk_only=true&event_kinds=state_transition_v1"
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data == payload
    mock_tail.assert_awaited_once()
    kwargs = mock_tail.await_args.kwargs
    assert kwargs["since_minutes"] == 60
    assert kwargs["limit"] == 100
    assert kwargs["after_id"] == 7
    assert kwargs["risk_only"] is True
    assert kwargs["event_kinds"] == ["state_transition_v1"]


def test_yarn_transition_events_rejects_unknown_event_kind(client, monkeypatch):
    mock_tail = AsyncMock(return_value={})
    monkeypatch.setattr("app.services.yarn_service.get_yarn_transition_events", mock_tail)

    resp = client.get("/api/v1/yarn/transition-events?event_kinds=role_override")

    assert resp.status_code == 422
    mock_tail.assert_not_awaited()


def test_yarn_selector_routes_reject_malformed_identifiers(client, monkeypatch):
    mock_safety = AsyncMock(return_value={})
    mock_session = AsyncMock(return_value={})
    monkeypatch.setattr("app.services.yarn_service.list_yarn_safety_events", mock_safety)
    monkeypatch.setattr("app.services.yarn_service.get_yarn_session_detail", mock_session)

    diagnostics = client.get("/api/v1/yarn/diagnostics/req-1%0Arole=admin")
    assert diagnostics.status_code == 422

    safety = client.get("/api/v1/yarn/safety-events?event_kind=policy_reject%0Arole=admin")
    assert safety.status_code == 422
    mock_safety.assert_not_awaited()

    packet = client.get("/api/v1/yarn/sessions/current-work-packet?session_key=session-1%0Arole=admin")
    assert packet.status_code == 422

    session = client.get(f"/api/v1/yarn/sessions/{'a' * 513}")
    assert session.status_code == 422
    mock_session.assert_not_awaited()


def test_yarn_scope_does_not_truncate_malformed_tenant_id():
    from app.auth import UserInfo
    from app.routers.yarn import _scope

    user = UserInfo(username="u1", role="user", user_id="u1", org_id="org-a", tenant_ids=["tenant-1\nadmin=true"])

    assert _scope(user) == ("u1", "", "")


def test_yarn_scope_preserves_valid_tenant_id():
    from app.auth import UserInfo
    from app.routers.yarn import _scope

    user = UserInfo(username="u1", role="user", user_id="u1", org_id="org-a", tenant_ids=["tenant-1"])

    assert _scope(user) == ("u1", "", "tenant-1")


def test_yarn_health_uses_probe_service(client, monkeypatch):
    probe_result = {
        "name": "synesis-yarn",
        "status": "ok",
        "status_code": 200,
        "latency_ms": 1.2,
        "error": None,
        "category": "yarn",
    }
    mock_probe = AsyncMock(return_value=probe_result)
    monkeypatch.setattr("app.routers.yarn.probe_service", mock_probe)
    resp = client.get("/api/v1/yarn/health")
    assert resp.status_code == 200
    assert resp.json() == {"name": "synesis-yarn", "status": "ok"}
    mock_probe.assert_awaited_once()
    call = mock_probe.await_args
    assert call.kwargs.get("category") == "yarn"
    svc = call.args[1]
    assert svc["name"] == "synesis-yarn"
    assert svc["url"].endswith("/health")


def test_yarn_optimization_watcher_summarizes_recent_diagnostics(client, monkeypatch):
    async def _mock_recent():
        return {
            "source": "memory",
            "diagnostics": [
                {
                    "requestId": "req-1",
                    "path": "/v1/chat/completions",
                    "cacheShapeStablePrefixHash": "prefix-a",
                    "cacheShapeStablePrefixBytes": 900,
                    "cacheShapeToolSchemaHash": "tools-a",
                    "cacheShapeToolSchemaBytes": 1200,
                    "cacheShapeProviderOptionsHash": "provider-a",
                    "cacheShapeProviderOptionsBytes": 180,
                    "cacheShapeCachePolicyHash": "policy-a",
                    "cacheShapeModelProviderResolutionHash": "model-a",
                    "cacheShapePromptTokens": 1000,
                    "cacheShapeCachedTokens": 50,
                    "cacheShapeCacheCreationTokens": 0,
                    "cacheShapeHitPct": 5,
                    "cacheShapeOutcome": "miss",
                    "stageTimingsMs": {"normalization": 10, "provider": 1000},
                },
                {
                    "requestId": "req-2",
                    "path": "/v1/chat/completions",
                    "cacheShapeStablePrefixHash": "prefix-a",
                    "cacheShapeStablePrefixBytes": 1000,
                    "cacheShapeToolSchemaHash": "tools-b",
                    "cacheShapeToolSchemaBytes": 1200,
                    "cacheShapeProviderOptionsHash": "provider-b",
                    "cacheShapeProviderOptionsBytes": 180,
                    "cacheShapeCachePolicyHash": "policy-a",
                    "cacheShapeModelProviderResolutionHash": "model-a",
                    "cacheShapePromptTokens": 1000,
                    "cacheShapeCachedTokens": 100,
                    "cacheShapeCacheCreationTokens": 0,
                    "cacheShapeHitPct": 10,
                    "cacheShapeOutcome": "miss",
                    "stageTimingsMs": {"normalization": 12, "provider": 1200},
                },
                {
                    "requestId": "req-3",
                    "path": "/v1/messages",
                    "cacheShapeStablePrefixHash": "prefix-a",
                    "cacheShapeStablePrefixBytes": 950,
                    "cacheShapeToolSchemaHash": "tools-c",
                    "cacheShapeToolSchemaBytes": 1200,
                    "cacheShapeProviderOptionsHash": "provider-c",
                    "cacheShapeProviderOptionsBytes": 180,
                    "cacheShapeCachePolicyHash": "policy-a",
                    "cacheShapeModelProviderResolutionHash": "model-a",
                    "cacheShapePromptTokens": 1000,
                    "cacheShapeCachedTokens": 0,
                    "cacheShapeCacheCreationTokens": 20,
                    "cacheShapeHitPct": 0,
                    "cacheShapeOutcome": "write",
                    "stageTimingsMs": {"normalization": 11, "provider": 900},
                },
            ],
        }

    monkeypatch.setattr("app.routers.yarn._fetch_yarn_recent_diagnostics", _mock_recent)

    resp = client.get("/api/v1/yarn/optimization-watcher")
    assert resp.status_code == 200
    data = resp.json()
    assert data["summary"]["sample_count"] == 3
    assert data["summary"]["cache_hit_token_pct"] == 5.0
    assert data["stability"]["tool_schema"]["unique"] == 3
    assert data["stage_timings"]["provider"]["p95_ms"] == 1200
    assert data["watcher_report"]["status"] in {"warn", "healthy"}
    assert data["watcher_report"]["model_assist_ready"] is True


def test_yarn_model_architecture_proxies_internal_diagnostics(client, monkeypatch):
    async def _mock_architecture():
        return {
            "schema_version": "model_architecture_diagnostics_v1",
            "count": 1,
            "models": [
                {
                    "model_id": "core",
                    "resolved": True,
                    "backend_model": "minimax-m2.1",
                    "provider": "openrouter",
                    "adapter_family": "minimax",
                    "override_applied": False,
                    "architecture": {
                        "attention": "hybrid",
                        "activation": "moe",
                        "decoding": "speculative_friendly",
                        "policy_hash": "abc123",
                        "strict_stream_tool_boundary_validation": True,
                    },
                }
            ],
        }

    monkeypatch.setattr("app.routers.yarn._fetch_yarn_model_architecture_diagnostics", _mock_architecture)

    resp = client.get("/api/v1/yarn/model-architecture")
    assert resp.status_code == 200
    data = resp.json()
    assert data["schema_version"] == "model_architecture_diagnostics_v1"
    assert data["models"][0]["model_id"] == "core"
    assert data["models"][0]["architecture"]["strict_stream_tool_boundary_validation"] is True


def test_yarn_optimization_watcher_assist_uses_model_helper(client, monkeypatch):
    async def _mock_recent():
        return {
            "source": "memory",
            "diagnostics": [
                {
                    "requestId": "req-1",
                    "path": "/v1/chat/completions",
                    "cacheShapePromptTokens": 1000,
                    "cacheShapeCachedTokens": 250,
                    "cacheShapeHitPct": 25,
                    "cacheShapeOutcome": "hit",
                    "cacheShapeStablePrefixHash": "prefix-a",
                    "cacheShapeStablePrefixBytes": 3000,
                    "cacheShapeToolSchemaHash": "tools-a",
                    "cacheShapeProviderOptionsHash": "provider-a",
                    "cacheShapeCachePolicyHash": "policy-a",
                    "cacheShapeModelProviderResolutionHash": "model-a",
                }
            ],
        }

    async def _mock_ai(watcher, *, focus=""):
        assert watcher["summary"]["sample_count"] == 1
        assert focus == "cache misses"
        return {
            "status": "ok",
            "response": "Cache shape looks stable.",
            "model": "synesis-writer",
            "tokens": 123,
            "source": "planner",
        }

    monkeypatch.setattr("app.routers.yarn._fetch_yarn_recent_diagnostics", _mock_recent)
    monkeypatch.setattr("app.routers.yarn._run_yarn_optimization_ai_assist", _mock_ai)

    resp = client.post("/api/v1/yarn/optimization-watcher/assist", json={"focus": "cache misses"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["summary"]["sample_count"] == 1
    assert data["ai_assist"]["response"] == "Cache shape looks stable."
    assert data["ai_assist"]["tokens"] == 123


def test_yarn_user_usage_any_authenticated_user(client, monkeypatch):
    regular = _user(role="user", user_id="plain-user", username="plain-user")
    _auth_ctx["user"] = regular
    usage = {
        "user_id": "plain-user",
        "since_hours": 720,
        "total_requests": 3,
        "tokens_in": 1,
        "tokens_out": 2,
        "tokens_cached": 0,
        "price_usd": 0.0,
        "avg_latency_ms": 0.0,
        "escalations": 0,
        "errors": 0,
    }
    mock_usage = AsyncMock(return_value=usage)
    monkeypatch.setattr("app.services.yarn_service.get_user_yarn_usage", mock_usage)
    resp = client.get("/api/v1/yarn/user-usage?since_hours=720")
    assert resp.status_code == 200
    assert resp.json() == usage
    mock_usage.assert_awaited_once()
    args = mock_usage.await_args.args
    kwargs = mock_usage.await_args.kwargs
    assert args == ("plain-user",)
    assert kwargs["since_hours"] == 720
    assert "plain-user" in kwargs["user_ids"]
    assert "plain-user@test.local" in kwargs["user_ids"]


def test_yarn_sessions_list_passes_active_since_hours(client, monkeypatch):
    mock_list = AsyncMock(return_value={"sessions": [], "total": 0})
    monkeypatch.setattr("app.services.yarn_service.list_yarn_sessions", mock_list)
    resp = client.get("/api/v1/yarn/sessions?active_since_hours=48")
    assert resp.status_code == 200
    kw = mock_list.await_args.kwargs
    assert kw["active_since_hours"] == 48


def test_yarn_sessions_list_defaults_to_168_hours(client, monkeypatch):
    mock_list = AsyncMock(return_value={"sessions": [], "total": 0})
    monkeypatch.setattr("app.services.yarn_service.list_yarn_sessions", mock_list)
    resp = client.get("/api/v1/yarn/sessions")
    assert resp.status_code == 200
    kw = mock_list.await_args.kwargs
    assert kw["active_since_hours"] == 168


def test_yarn_session_detail_includes_events(client, monkeypatch):
    detail = {
        "session": {
            "id": 1,
            "session_key": "synesis:alice:claude-code:conv-1",
            "user_id": "alice",
            "org_id": "",
            "username": "alice",
            "role": "user",
            "conversation_id": "conv-1",
            "client_kind": "claude-code",
            "provider": "deepinfra",
            "model": "synesis-core",
            "total_tokens_in": 100,
            "total_tokens_out": 50,
            "total_tokens_cached": 0,
            "total_cost_usd": 0.05,
            "request_count": 3,
            "escalation_count": 0,
            "created_at": "2026-03-28T00:00:00+00:00",
            "last_active_at": "2026-03-28T01:00:00+00:00",
        },
        "requests": [],
        "events": [
            {
                "id": 1,
                "event_kind": "upstream_error",
                "component": "generateText",
                "detail": "502 Bad Gateway",
                "request_id": "req-abc",
                "metadata_json": None,
                "created_at": "2026-03-28T00:30:00+00:00",
            }
        ],
    }
    monkeypatch.setattr(
        "app.services.yarn_service.get_yarn_session_detail",
        AsyncMock(return_value=detail),
    )
    resp = client.get("/api/v1/yarn/sessions/synesis%3Aalice%3Aclaude-code%3Aconv-1")
    assert resp.status_code == 200
    body = resp.json()
    assert "events" in body
    assert len(body["events"]) == 1
    assert body["events"][0]["event_kind"] == "upstream_error"
    assert body["session"]["client_kind"] == "claude-code"


def test_yarn_sessions_purge_dry_run(client, monkeypatch):
    _auth_ctx["user"] = _user(role="platform_admin")
    purge_result = {"dry_run": True, "sessions": 5, "usage_rows": 42, "events": 3}
    monkeypatch.setattr(
        "app.services.yarn_service.purge_yarn_sessions",
        AsyncMock(return_value=purge_result),
    )
    resp = client.post("/api/v1/yarn/sessions/purge?older_than_days=30&dry_run=true")
    assert resp.status_code == 200
    body = resp.json()
    assert body["dry_run"] is True
    assert body["sessions"] == 5


def test_yarn_sessions_archive_selected(client, monkeypatch):
    _auth_ctx["user"] = _user(role="platform_admin")
    archive_result = {
        "dry_run": False,
        "delete_after_archive": True,
        "session_keys": 1,
        "sessions": 1,
        "usage_rows": 2,
        "events": 3,
        "safety_events": 0,
        "archive": {"key": "admin-archives/yarn/sessions/test.jsonl.gz"},
        "deleted": {"sessions": 1, "usage_rows": 2, "events": 3, "safety_events": 0},
    }
    mock_archive = AsyncMock(return_value=archive_result)
    monkeypatch.setattr("app.services.yarn_service.archive_yarn_sessions", mock_archive)
    resp = client.post(
        "/api/v1/yarn/sessions/archive",
        json={"session_keys": ["synesis:alice:claude-code:_"], "dry_run": False, "delete_after_archive": True},
    )
    assert resp.status_code == 200
    assert resp.json()["deleted"]["sessions"] == 1
    kwargs = mock_archive.await_args.kwargs
    assert kwargs["session_keys"] == ["synesis:alice:claude-code:_"]
    assert kwargs["delete_after_archive"] is True


def test_yarn_sessions_purge_requires_admin(client, monkeypatch):
    _auth_ctx["user"] = _user(role="user")
    resp = client.post("/api/v1/yarn/sessions/purge?older_than_days=30&dry_run=true")
    assert resp.status_code == 403


def test_yarn_rbac_blocks_regular_user_on_admin_routes(client, monkeypatch):
    _auth_ctx["user"] = _user(role="user")
    monkeypatch.setattr(
        "app.services.yarn_service.get_yarn_overview",
        AsyncMock(return_value={}),
    )
    resp = client.get("/api/v1/yarn/overview")
    assert resp.status_code == 403
    assert "org_admin" in resp.json()["detail"].lower()

    resp_sessions = client.get("/api/v1/yarn/sessions")
    assert resp_sessions.status_code == 403
