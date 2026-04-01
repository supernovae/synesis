"""Smoke tests for admin quality / feedback-loop API endpoints.

These verify that every route in docs/ADMIN_QUALITY_UI.md returns a valid
response (not 5xx) with expected top-level keys.  They do NOT require a live
Milvus or Postgres — mocks are injected where needed.

Run from base/admin/:
    PYTHONPATH=. uv run pytest tests/test_quality_smoke.py -v
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fake_user():
    from app.auth import UserInfo

    return UserInfo(
        user_id="smoke-tester",
        username="smoke-tester",
        email="smoke@test.local",
        role="admin",
        org_id="",
        org_name="",
    )


class _FakeScalar:
    """Minimal stand-in for SQLAlchemy scalar results."""

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
        return MagicMock(total=0, errors=0, avg_duration=0, avg_tokens=0, avg_cost=0, total_cost=0)


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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _mock_all(monkeypatch):
    """Patch auth, DB, Milvus, and HTTP-calling services."""
    monkeypatch.setattr("app.auth.get_current_user", lambda: _fake_user())
    monkeypatch.setattr("app.auth.require_admin", lambda: _fake_user())
    monkeypatch.setattr("app.db.engine.async_session", _fake_async_session)
    monkeypatch.setattr(
        "app.services.milvus_service.collection_stats",
        lambda *a, **kw: {"row_count": 42},
    )
    monkeypatch.setattr(
        "app.services.milvus_service.collection_domain_hierarchy",
        lambda *a, **kw: [],
    )
    monkeypatch.setattr(
        "app.services.milvus_service.safe_query",
        lambda *a, **kw: [],
    )
    monkeypatch.setattr(
        "app.services.milvus_service.collection_schema_info",
        lambda *a, **kw: {"exists": True},
    )
    monkeypatch.setattr("app.deps.QUALITY_REPORT_PATH", "")
    monkeypatch.setattr("app.deps.CURATOR_PROPOSALS_PATH", "")


@pytest.fixture()
def client():
    from app.main import app
    from app.auth import create_token

    token = create_token("smoke-tester", "platform_admin")
    headers = {"Authorization": f"Bearer {token}"}
    return TestClient(app, raise_server_exceptions=False, headers=headers)


# ---------------------------------------------------------------------------
# Tests — one per route in ADMIN_QUALITY_UI table
# ---------------------------------------------------------------------------


def test_dashboard_quality_wiring(client):
    resp = client.get("/api/v1/dashboard/quality-wiring")
    assert resp.status_code == 200
    data = resp.json()
    assert "milvus_ok" in data


def test_rag_quality(client):
    resp = client.get("/api/v1/rag/quality")
    assert resp.status_code == 200
    data = resp.json()
    assert "scorecards" in data


def test_rag_quality_refresh(client):
    resp = client.post("/api/v1/rag/quality/refresh")
    assert resp.status_code == 200


def test_rag_quality_domains(client):
    resp = client.get("/api/v1/rag/quality/domains")
    assert resp.status_code == 200
    data = resp.json()
    assert "domains" in data


def test_rag_quality_domain_detail(client):
    resp = client.get("/api/v1/rag/quality/domains/test-domain")
    assert resp.status_code == 200
    data = resp.json()
    assert data["domain"] == "test-domain"


def test_rag_quality_import_report(client):
    report = {
        "summary": {"strong": 1},
        "scorecards": [
            {
                "domain": "test-domain",
                "health": "strong",
                "inventory": {"total_chunks": 100, "total_documents": 10},
                "coverage": {"hit_rate": 0.9, "mean_mrr": 0.8},
                "dead_weight": {"unretrieved_documents": 2},
            }
        ],
    }
    resp = client.post("/api/v1/rag/quality/import-report", json=report)
    assert resp.status_code == 200


def test_rag_corpus(client):
    resp = client.get("/api/v1/rag/corpus")
    assert resp.status_code == 200
    data = resp.json()
    assert "total_chunks" in data


def test_rag_benchmarks(client):
    resp = client.get("/api/v1/rag/benchmarks")
    assert resp.status_code == 200


def test_rag_benchmarks_history(client):
    resp = client.get("/api/v1/rag/benchmarks/history")
    assert resp.status_code == 200
    assert "runs" in resp.json()


def test_rag_benchmarks_import(client):
    body = {"aggregate": {"mrr": 0.65}, "per_query": []}
    resp = client.post("/api/v1/rag/benchmarks/import", json=body)
    assert resp.status_code == 200


def test_rag_review_stats(client):
    resp = client.get("/api/v1/rag/review/stats")
    assert resp.status_code == 200


def test_rag_review_queue(client):
    resp = client.get("/api/v1/rag/review")
    assert resp.status_code == 200
    assert "chunks" in resp.json()


def test_feedback_knowledge_gaps(client):
    resp = client.get("/api/v1/feedback/knowledge-gaps")
    assert resp.status_code == 200
    data = resp.json()
    assert "gaps" in data


def test_feedback_curator(client):
    resp = client.get("/api/v1/feedback/curator")
    assert resp.status_code == 200
    assert "proposals" in resp.json()


def test_observability_knowledge_gaps(client):
    resp = client.get("/api/v1/observability/knowledge-gaps")
    assert resp.status_code == 200
    assert "gaps" in resp.json()


def test_observability_knowledge_gap_stats(client):
    resp = client.get("/api/v1/observability/knowledge-gaps/stats")
    assert resp.status_code == 200
    assert "total_gaps" in resp.json()


def test_traces_list(client):
    resp = client.get("/api/v1/traces")
    assert resp.status_code == 200
    data = resp.json()
    assert "traces" in data


def test_traces_hallucination_filter(client):
    resp = client.get("/api/v1/traces?min_hallucinated_urls=1")
    assert resp.status_code == 200
    data = resp.json()
    assert "traces" in data


def test_traces_stats(client):
    resp = client.get("/api/v1/traces/stats")
    assert resp.status_code == 200


def test_models_effort_recommend_preview(client, monkeypatch):
    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {
                "requested_mode": "auto",
                "selected_mode": "core",
                "recommendation": {
                    "recommended_mode": "core",
                    "confidence": 0.8,
                    "reasons": ["test"],
                    "routing_signals": {
                        "complexity": 0.5,
                        "ambiguity": 0.4,
                        "risk": 0.3,
                        "scope": 0.4,
                        "user_intent": 0.5,
                        "operational_health": 1.0,
                    },
                },
                "classification": {"difficulty": "moderate"},
                "policy": {"retrieval_depth": 5},
            }

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, *args, **kwargs):
            return _Resp()

    monkeypatch.setenv("SYNESIS_INTERNAL_SERVICE_TOKEN", "test-token")
    monkeypatch.setattr("app.routers.models.httpx.AsyncClient", lambda timeout=20.0: _Client())

    resp = client.post(
        "/api/v1/models/effort/recommend",
        json={
            "prompt": "Design a scalable architecture",
            "effort_mode": "auto",
            "include_frame": False,
            "operational_health": 1.0,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["selected_mode"] == "core"
