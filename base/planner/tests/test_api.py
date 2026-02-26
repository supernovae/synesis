"""Smoke tests for the FastAPI endpoints -- validates HTTP contract.

Uses FastAPI's TestClient so no real LLM calls are made. The /health
and /v1/models endpoints are fully testable. The /v1/chat/completions
endpoint requires mocking the graph.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from app.main import app
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage


@pytest.fixture
def client():
    return TestClient(app)


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
        assert data["data"][0]["id"] == "synesis-agent"


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

    def test_streaming_not_supported(self, client):
        resp = client.post(
            "/v1/chat/completions",
            json={
                "model": "synesis-agent",
                "messages": [{"role": "user", "content": "hi"}],
                "stream": True,
            },
        )
        assert resp.status_code == 400
        assert "Streaming" in resp.json()["detail"]

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
        assert "LLM unreachable" in resp.json()["detail"]

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
