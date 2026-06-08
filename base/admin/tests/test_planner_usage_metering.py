"""Planner usage log ingest and double-count diagnostics."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from app.main import app

    return TestClient(app)


def test_planner_metering_ingest_requires_token_when_configured(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    token = "test-service-token"
    monkeypatch.setenv("SYNESIS_INTERNAL_SERVICE_TOKEN", token)
    monkeypatch.delenv("SYNESIS_INTERNAL_SERVICE_TOKENS", raising=False)
    payload = {
        "request_id": "test-meter-req-1",
        "user_id": "u1",
        "org_id": "o1",
        "tenant_id": "",
        "conversation_id": "",
        "model": "synesis-agent",
        "tokens_in": 10,
        "tokens_out": 5,
        "tokens_cached": 0,
        "estimated_cost_usd": 0.0001,
        "actual_cost_usd": 0.0,
        "pricing_source": "registry",
        "latency_ms": 100.0,
        "has_error": False,
    }
    with patch("app.routers.planner_usage.upsert_metering_row", new_callable=AsyncMock):
        r = client.post("/api/v1/planner/usage/metering", json=payload)
        assert r.status_code == 401
        r2 = client.post(
            "/api/v1/planner/usage/metering",
            json=payload,
            headers={"x-synesis-service-token": token},
        )
        assert r2.status_code == 200
        assert r2.json().get("status") == "ok"


def test_planner_metering_ingest_accepts_case_insensitive_bearer(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    token = "test-service-token"
    monkeypatch.setenv("SYNESIS_INTERNAL_SERVICE_TOKEN", token)
    monkeypatch.delenv("SYNESIS_INTERNAL_SERVICE_TOKENS", raising=False)
    payload = {
        "request_id": "test-meter-req-2",
        "user_id": "u1",
        "org_id": "o1",
        "tenant_id": "",
        "conversation_id": "",
        "model": "synesis-agent",
        "tokens_in": 10,
        "tokens_out": 5,
        "tokens_cached": 0,
        "estimated_cost_usd": 0.0001,
        "actual_cost_usd": 0.0,
        "pricing_source": "registry",
        "latency_ms": 100.0,
        "has_error": False,
    }
    with patch("app.routers.planner_usage.upsert_metering_row", new_callable=AsyncMock):
        r = client.post(
            "/api/v1/planner/usage/metering",
            json=payload,
            headers={"Authorization": f"bearer {token}"},
        )
        assert r.status_code == 200
        assert r.json().get("status") == "ok"


def test_usage_me_summary_requires_auth(client: TestClient):
    r = client.get("/api/v1/usage/me/summary?since_hours=24")
    assert r.status_code == 401
