"""Planner usage log ingest and double-count diagnostics."""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from app.main import app

    return TestClient(app)


def test_planner_metering_ingest_requires_token_when_configured(client: TestClient):
    token = os.environ.get("SYNESIS_INTERNAL_SERVICE_TOKEN", "")
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
    r = client.post("/api/v1/planner/usage/metering", json=payload)
    if token:
        assert r.status_code == 401
        r2 = client.post(
            "/api/v1/planner/usage/metering",
            json=payload,
            headers={"x-synesis-service-token": token},
        )
        assert r2.status_code == 200
        assert r2.json().get("status") == "ok"
    else:
        assert r.status_code == 200


def test_usage_me_summary_requires_auth(client: TestClient):
    r = client.get("/api/v1/usage/me/summary?since_hours=24")
    assert r.status_code == 401
