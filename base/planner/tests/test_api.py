"""Smoke tests for the FastAPI endpoints -- validates HTTP contract.

Uses FastAPI's TestClient so no real LLM calls are made. The /health
and /v1/models endpoints are fully testable. The /v1/chat/completions
endpoint requires mocking the graph.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

pytest.importorskip("fastapi", reason="fastapi not installed (container-only)")
pytest.importorskip("langgraph", reason="langgraph not installed (container-only)")

import app.main as planner_main_module
from app.config import settings as planner_settings
from app.main import app, normalize_planner_client_model
from app.pat_auth import PatAuthContext
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage


def _sse_completion_chunks(text: str) -> list[dict]:
    """Parse ``data: {...}`` JSON lines from an SSE body (OpenAI stream)."""
    out: list[dict] = []
    for line in text.splitlines():
        if not line.startswith("data: "):
            continue
        payload = line[6:].strip()
        if not payload or payload == "[DONE]":
            continue
        if not payload.startswith("{"):
            continue
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if obj.get("object") == "chat.completion.chunk" and obj.get("choices"):
            out.append(obj)
    return out


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_planner_prompt_cache():
    """Cache key is prompt+model only; streaming tests would otherwise skip graph on later tests."""
    planner_main_module._prompt_cache.clear()
    yield
    planner_main_module._prompt_cache.clear()


class TestNormalizePlannerModel:
    def test_legacy_and_display_ids(self):
        assert normalize_planner_client_model("synesis-agent") == ("Synesis", False)
        assert normalize_planner_client_model("Synesis") == ("Synesis", False)
        assert normalize_planner_client_model("Synesis Thinking") == ("Synesis Thinking", True)
        assert normalize_planner_client_model("synesis-thinking-chat") == ("Synesis Thinking", True)
        assert normalize_planner_client_model("openai/Synesis") == ("Synesis", False)
        assert normalize_planner_client_model("openai/synesis thinking") == ("Synesis Thinking", True)


class TestHealthEndpoints:
    def test_health(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_readiness(self, client):
        resp = client.get("/health/readiness")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ready"


class TestModelsEndpoint:
    def test_list_models(self, client):
        resp = client.get("/v1/models")
        assert resp.status_code == 200
        data = resp.json()
        assert data["object"] == "list"
        assert len(data["data"]) >= 1
        ids = {m["id"] for m in data["data"]}
        assert "Synesis" in ids
        assert "Synesis Thinking" in ids
        for m in data["data"]:
            assert m.get("object") == "model"
            assert isinstance(m.get("created"), int)
            assert m.get("owned_by")
            assert "permission" not in m


class TestChatCompletions:
    @patch("app.main.graph")
    def test_basic_request(self, mock_graph, client):
        mock_graph.ainvoke = AsyncMock(
            return_value={
                "messages": [AIMessage(content="Hello from Synesis!")],
                "iteration_count": 1,
                "node_traces": [],
            }
        )
        resp = client.post(
            "/v1/chat/completions",
            json={
                "model": "synesis-agent",
                "messages": [{"role": "user", "content": "write a hello world"}],
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["object"] == "chat.completion"
        assert body["choices"][0]["message"]["content"] == "Hello from Synesis!"
        usage = body.get("usage") or {}
        for key in ("prompt_tokens", "completion_tokens", "total_tokens", "cached_prompt_tokens"):
            assert key in usage
            assert isinstance(usage[key], int)

    @patch("app.main.resolve_pat_or_none", new_callable=AsyncMock)
    @patch("app.main.graph")
    def test_pat_bearer_resolves_user_id(self, mock_graph, mock_pat, client):
        mock_pat.return_value = PatAuthContext(
            user_id="pat-user-99",
            org_id="org-1",
            tenant_ids=[],
            username="alice@example.com",
            role="user",
            scopes=["model:readonly"],
            token_row_id="row-1",
        )
        mock_graph.ainvoke = AsyncMock(
            return_value={
                "messages": [AIMessage(content="Hello from Synesis!")],
                "iteration_count": 1,
                "node_traces": [],
            }
        )
        resp = client.post(
            "/v1/chat/completions",
            headers={"Authorization": "Bearer syn-fake"},
            json={
                "model": "synesis-agent",
                "messages": [{"role": "user", "content": "write a hello world"}],
            },
        )
        assert resp.status_code == 200
        state = mock_graph.ainvoke.call_args[0][0]
        assert state["user_id"] == "pat-user-99"

    def test_no_user_messages(self, client):
        resp = client.post(
            "/v1/chat/completions",
            json={
                "model": "synesis-agent",
                "messages": [{"role": "system", "content": "you are a helper"}],
            },
        )
        assert resp.status_code == 400
        assert "No user messages" in resp.json()["detail"]

    @patch("app.main.graph")
    def test_streaming_returns_sse_with_status_events(self, mock_graph, client, monkeypatch):
        """Streaming uses astream and emits status events plus final content."""

        _s = planner_settings.model_copy(update={"streaming_events_enabled": False})
        monkeypatch.setattr(planner_main_module, "settings", _s)

        async def mock_astream(init_state, *, stream_mode, config=None):
            # Simulate two node completions then end
            yield {"current_node": "entry_classifier", "messages": []}
            yield {
                "current_node": "context_curator",
                "messages": [],
            }
            yield {
                "current_node": "worker",
                "messages": [],
            }
            yield {
                "current_node": "respond",
                "messages": [AIMessage(content="Here is your code.")],
            }

        mock_graph.astream = mock_astream
        resp = client.post(
            "/v1/chat/completions",
            json={
                "model": "synesis-agent",
                "messages": [{"role": "user", "content": "hi"}],
                "stream": True,
                "stream_options": {"include_usage": True},
            },
        )
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")
        body = resp.text
        assert "Here is your code." in body
        assert "[DONE]" in body
        chunks = _sse_completion_chunks(body)
        assert chunks
        final = chunks[-1]
        assert final["choices"][0].get("finish_reason")
        usage = final.get("usage") or {}
        for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
            assert key in usage

    @patch("app.main.graph")
    def test_streaming_without_include_usage_omits_usage_on_final_chunk(self, mock_graph, client, monkeypatch):
        _s = planner_settings.model_copy(update={"streaming_events_enabled": False})
        monkeypatch.setattr(planner_main_module, "settings", _s)

        async def mock_astream(init_state, *, stream_mode, config=None):
            yield {"current_node": "entry_classifier", "messages": []}
            yield {"current_node": "context_curator", "messages": []}
            yield {"current_node": "worker", "messages": []}
            yield {"current_node": "respond", "messages": [AIMessage(content="Here is your code.")]}

        mock_graph.astream = mock_astream
        resp = client.post(
            "/v1/chat/completions",
            json={
                "model": "synesis-agent",
                "messages": [{"role": "user", "content": "hi"}],
                "stream": True,
            },
        )
        assert resp.status_code == 200
        chunks = _sse_completion_chunks(resp.text)
        assert chunks
        assert "usage" not in chunks[-1]

    @patch("app.main.graph")
    def test_graph_error_returns_500(self, mock_graph, client):
        mock_graph.ainvoke = AsyncMock(side_effect=RuntimeError("LLM unreachable"))
        resp = client.post(
            "/v1/chat/completions",
            json={
                "model": "synesis-agent",
                "messages": [{"role": "user", "content": "test"}],
            },
        )
        assert resp.status_code == 500
        assert "Graph execution failed" in resp.json()["detail"]

    @patch("app.main.graph")
    def test_with_retrieval_options(self, mock_graph, client):
        mock_graph.ainvoke = AsyncMock(
            return_value={
                "messages": [AIMessage(content="result")],
                "iteration_count": 1,
                "node_traces": [],
            }
        )
        resp = client.post(
            "/v1/chat/completions",
            json={
                "model": "synesis-agent",
                "messages": [{"role": "user", "content": "test"}],
                "retrieval": {
                    "strategy": "bm25",
                    "reranker": "none",
                    "top_k": 3,
                },
            },
        )
        assert resp.status_code == 200
        call_args = mock_graph.ainvoke.call_args[0][0]
        assert call_args["retrieval_params"].strategy == "bm25"
        assert call_args["retrieval_params"].reranker == "none"

    @patch("app.main.graph")
    def test_user_id_from_request(self, mock_graph, client):
        mock_graph.ainvoke = AsyncMock(
            return_value={
                "messages": [AIMessage(content="ok")],
                "iteration_count": 1,
                "node_traces": [],
            }
        )
        resp = client.post(
            "/v1/chat/completions",
            json={
                "model": "synesis-agent",
                "messages": [{"role": "user", "content": "hi"}],
                "user": "test-user-42",
            },
        )
        assert resp.status_code == 200
        call_args = mock_graph.ainvoke.call_args[0][0]
        assert call_args["user_id"] == "test-user-42"


class TestFeedbackEndpoints:
    def test_post_feedback_stores_vote(self, client):
        resp = client.post(
            "/v1/feedback",
            json={
                "message_id": "msg_123",
                "run_id": "550e8400-e29b-41d4-a716-446655440000",
                "vote": "down",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "stored"

    def test_post_feedback_invalid_vote(self, client):
        resp = client.post(
            "/v1/feedback",
            json={
                "message_id": "msg_123",
                "run_id": "550e8400-e29b-41d4-a716-446655440000",
                "vote": "maybe",
            },
        )
        assert resp.status_code == 400

    def test_get_feedback_returns_list(self, client):
        resp = client.get("/v1/feedback")
        assert resp.status_code == 200
        data = resp.json()
        assert data["object"] == "list"
        assert "data" in data

    def test_get_feedback_filter_by_vote(self, client):
        resp = client.get("/v1/feedback?vote=down")
        assert resp.status_code == 200
