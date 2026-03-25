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
        assert normalize_planner_client_model("synesis-auto") == ("Synesis Auto", False)
        assert normalize_planner_client_model("synesis-pulse") == ("Synesis Pulse", False)
        assert normalize_planner_client_model("synesis-core") == ("Synesis Core", False)
        assert normalize_planner_client_model("synesis-horizon") == ("Synesis Horizon", False)


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
        assert "Synesis Auto" in ids
        assert "Synesis Pulse" in ids
        assert "Synesis Core" in ids
        assert "Synesis Horizon" in ids
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
        body = resp.json()
        assert "No user messages" in body["error"]["message"]

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
    def test_streaming_without_include_usage_includes_usage_on_final_chunk(self, mock_graph, client, monkeypatch):
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
        usage = chunks[-1].get("usage") or {}
        for key in ("prompt_tokens", "completion_tokens", "total_tokens", "cached_prompt_tokens"):
            assert key in usage

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
        body = resp.json()
        assert "Graph execution failed" in body["error"]["message"]

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
            headers={"Authorization": "Bearer test-key"},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "stored"

    def test_post_feedback_rejects_unauthenticated(self, client):
        resp = client.post(
            "/v1/feedback",
            json={
                "message_id": "msg_123",
                "run_id": "550e8400-e29b-41d4-a716-446655440000",
                "vote": "down",
            },
        )
        assert resp.status_code == 401

    def test_post_feedback_invalid_vote(self, client):
        resp = client.post(
            "/v1/feedback",
            json={
                "message_id": "msg_123",
                "run_id": "550e8400-e29b-41d4-a716-446655440000",
                "vote": "maybe",
            },
            headers={"Authorization": "Bearer test-key"},
        )
        assert resp.status_code == 400

    def test_get_feedback_returns_list(self, client):
        resp = client.get("/v1/feedback", headers={"Authorization": "Bearer test-key"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["object"] == "list"
        assert "data" in data

    def test_get_feedback_filter_by_vote(self, client):
        resp = client.get("/v1/feedback?vote=down", headers={"Authorization": "Bearer test-key"})
        assert resp.status_code == 200


class TestEffortRecommendationEndpoint:
    def test_requires_bearer(self, client):
        resp = client.post("/v1/effort/recommend", json={"prompt": "design a system"})
        assert resp.status_code == 401

    def test_returns_recommendation_payload(self, client):
        resp = client.post(
            "/v1/effort/recommend",
            headers={"Authorization": "Bearer test-key"},
            json={"prompt": "design a production architecture for multi-tenant platform", "effort_mode": "auto"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["requested_mode"] == "auto"
        assert body["selected_mode"] in {"pulse", "core", "horizon"}
        assert "recommendation" in body
        assert "classification" in body
        assert "policy" in body

    def test_manual_mode_override(self, client):
        resp = client.post(
            "/v1/effort/recommend",
            headers={"Authorization": "Bearer test-key"},
            json={"prompt": "small rewrite", "effort_mode": "pulse"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["requested_mode"] == "pulse"
        assert body["selected_mode"] == "pulse"
        assert body["policy"]["retrieval_depth"] <= 2


# ---------------------------------------------------------------------------
# OpenAI Error Envelope Compatibility
# ---------------------------------------------------------------------------


class TestOpenAIErrorEnvelope:
    """All HTTP errors must follow {"error": {"message", "type", "code"}}."""

    def test_400_no_user_messages(self, client):
        resp = client.post(
            "/v1/chat/completions",
            json={"model": "Synesis", "messages": [{"role": "system", "content": "hi"}]},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body
        assert "message" in body["error"]
        assert body["error"]["type"] == "invalid_request_error"
        assert "No user messages" in body["error"]["message"]

    def test_422_validation_error_shape(self, client):
        resp = client.post("/v1/chat/completions", json={"model": "Synesis"})
        assert resp.status_code == 422
        body = resp.json()
        assert "error" in body
        assert body["error"]["type"] == "invalid_request_error"

    @patch("app.main.graph")
    def test_500_graph_error_envelope(self, mock_graph, client):
        mock_graph.ainvoke = AsyncMock(side_effect=RuntimeError("LLM unreachable"))
        resp = client.post(
            "/v1/chat/completions",
            json={"model": "Synesis", "messages": [{"role": "user", "content": "hi"}]},
        )
        assert resp.status_code == 500
        body = resp.json()
        assert "error" in body
        assert body["error"]["type"] == "server_error"
        assert "Graph execution failed" in body["error"]["message"]


# ---------------------------------------------------------------------------
# Streaming Compatibility Tests
# ---------------------------------------------------------------------------


class TestStreamingCompat:
    """Streaming chunk invariants for strict OpenAI SDK parsers."""

    @patch("app.main.graph")
    def test_every_chunk_has_model_and_created(self, mock_graph, client, monkeypatch):
        _s = planner_settings.model_copy(update={"streaming_events_enabled": False})
        monkeypatch.setattr(planner_main_module, "settings", _s)

        async def mock_astream(init_state, *, stream_mode, config=None):
            yield {"current_node": "entry_classifier", "messages": []}
            yield {"current_node": "respond", "messages": [AIMessage(content="test")]}

        mock_graph.astream = mock_astream
        resp = client.post(
            "/v1/chat/completions",
            json={"model": "Synesis", "messages": [{"role": "user", "content": "hi"}], "stream": True},
        )
        assert resp.status_code == 200
        chunks = _sse_completion_chunks(resp.text)
        assert chunks
        for chunk in chunks:
            assert "model" in chunk, "Every chunk must have 'model'"
            assert "created" in chunk, "Every chunk must have 'created'"
            assert isinstance(chunk["created"], int)

    @patch("app.main.graph")
    def test_final_chunk_has_finish_reason_and_usage(self, mock_graph, client, monkeypatch):
        _s = planner_settings.model_copy(update={"streaming_events_enabled": False})
        monkeypatch.setattr(planner_main_module, "settings", _s)

        async def mock_astream(init_state, *, stream_mode, config=None):
            yield {"current_node": "entry_classifier", "messages": []}
            yield {"current_node": "respond", "messages": [AIMessage(content="ok")]}

        mock_graph.astream = mock_astream
        resp = client.post(
            "/v1/chat/completions",
            json={"model": "Synesis", "messages": [{"role": "user", "content": "hi"}], "stream": True},
        )
        chunks = _sse_completion_chunks(resp.text)
        final = chunks[-1]
        assert final["choices"][0]["finish_reason"] in ("stop", "length")
        usage = final.get("usage")
        assert usage is not None
        for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
            assert key in usage

    @patch("app.main.graph")
    def test_stream_done_termination(self, mock_graph, client, monkeypatch):
        _s = planner_settings.model_copy(update={"streaming_events_enabled": False})
        monkeypatch.setattr(planner_main_module, "settings", _s)

        async def mock_astream(init_state, *, stream_mode, config=None):
            yield {"current_node": "entry_classifier", "messages": []}
            yield {"current_node": "respond", "messages": [AIMessage(content="ok")]}

        mock_graph.astream = mock_astream
        resp = client.post(
            "/v1/chat/completions",
            json={"model": "Synesis", "messages": [{"role": "user", "content": "hi"}], "stream": True},
        )
        assert "data: [DONE]" in resp.text

    @patch("app.main.graph")
    def test_stream_error_emits_event_and_done(self, mock_graph, client, monkeypatch):
        _s = planner_settings.model_copy(update={"streaming_events_enabled": False})
        monkeypatch.setattr(planner_main_module, "settings", _s)

        async def mock_astream(init_state, *, stream_mode, config=None):
            yield {"current_node": "entry_classifier", "messages": []}
            raise RuntimeError("Model crashed")

        mock_graph.astream = mock_astream
        resp = client.post(
            "/v1/chat/completions",
            json={"model": "Synesis", "messages": [{"role": "user", "content": "hi"}], "stream": True},
        )
        assert resp.status_code == 200
        assert "event: error" in resp.text
        assert "data: [DONE]" in resp.text
        for line in resp.text.splitlines():
            if line.startswith("event: error"):
                idx = resp.text.index(line)
                data_line = resp.text[idx:].split("\n")[1]
                assert data_line.startswith("data: ")
                err = json.loads(data_line[6:])
                assert "error" in err

    @patch("app.main.graph")
    def test_non_chunk_status_lines_skippable(self, mock_graph, client, monkeypatch):
        """Status/event lines are not chat.completion.chunk — parsers must be able to skip them."""
        _s = planner_settings.model_copy(update={"streaming_events_enabled": False})
        monkeypatch.setattr(planner_main_module, "settings", _s)

        async def mock_astream(init_state, *, stream_mode, config=None):
            yield {"current_node": "entry_classifier", "messages": []}
            yield {"current_node": "respond", "messages": [AIMessage(content="hi")]}

        mock_graph.astream = mock_astream
        resp = client.post(
            "/v1/chat/completions",
            json={"model": "Synesis", "messages": [{"role": "user", "content": "hi"}], "stream": True},
        )
        all_data_lines = []
        for line in resp.text.splitlines():
            if line.startswith("data: ") and line[6:].strip() not in ("", "[DONE]"):
                try:
                    obj = json.loads(line[6:])
                    all_data_lines.append(obj)
                except json.JSONDecodeError:
                    pass
        chunk_lines = [d for d in all_data_lines if d.get("object") == "chat.completion.chunk"]
        status_lines = [d for d in all_data_lines if "event" in d]
        assert len(chunk_lines) >= 1, "Must have at least one chunk"
        # Status lines should exist (phase events) but be separate from chunks
        for sl in status_lines:
            assert sl.get("object") != "chat.completion.chunk"


# ---------------------------------------------------------------------------
# Auth Contract Tests (production-like)
# ---------------------------------------------------------------------------


class TestAuthContract:
    """Test auth behavior with bearer enforcement enabled."""

    @patch("app.main.graph")
    def test_chat_without_bearer_when_required(self, mock_graph, client, monkeypatch):
        _s = planner_settings.model_copy(update={"planner_require_bearer_auth": True})
        monkeypatch.setattr(planner_main_module, "settings", _s)
        resp = client.post(
            "/v1/chat/completions",
            json={"model": "Synesis", "messages": [{"role": "user", "content": "hi"}]},
        )
        assert resp.status_code == 401
        body = resp.json()
        assert body["error"]["type"] == "authentication_error"

    @patch("app.main.graph")
    def test_chat_with_bearer_when_required(self, mock_graph, client, monkeypatch):
        _s = planner_settings.model_copy(update={
            "planner_require_bearer_auth": True,
            "model_api_key": "test-api-key",
        })
        monkeypatch.setattr(planner_main_module, "settings", _s)
        mock_graph.ainvoke = AsyncMock(
            return_value={
                "messages": [AIMessage(content="ok")],
                "iteration_count": 1,
                "node_traces": [],
            }
        )
        resp = client.post(
            "/v1/chat/completions",
            headers={"Authorization": "Bearer test-api-key"},
            json={"model": "Synesis", "messages": [{"role": "user", "content": "hi"}]},
        )
        assert resp.status_code == 200

    def test_feedback_without_bearer_returns_401(self, client):
        resp = client.post(
            "/v1/feedback",
            json={"message_id": "m1", "run_id": "r1", "vote": "up"},
        )
        assert resp.status_code == 401
        body = resp.json()
        assert body["error"]["type"] == "authentication_error"

    def test_models_is_public(self, client):
        """GET /v1/models does not require auth (intentional)."""
        resp = client.get("/v1/models")
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Request Schema Compatibility
# ---------------------------------------------------------------------------


class TestRequestSchemaCompat:
    """Standard OpenAI clients send extra fields, multipart content, etc."""

    @patch("app.main.graph")
    def test_extra_fields_ignored(self, mock_graph, client):
        """Open WebUI sends frequency_penalty, top_p, etc. — must be ignored."""
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
                "model": "Synesis",
                "messages": [{"role": "user", "content": "hi"}],
                "frequency_penalty": 0.5,
                "top_p": 0.9,
                "presence_penalty": 0.1,
                "n": 1,
                "stop": ["\n"],
            },
        )
        assert resp.status_code == 200

    @patch("app.main.graph")
    def test_multipart_content_array(self, mock_graph, client):
        """content can be an array of typed parts (vision API format)."""
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
                "model": "Synesis",
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "describe this"},
                            {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
                        ],
                    }
                ],
            },
        )
        assert resp.status_code == 200
        state = mock_graph.ainvoke.call_args[0][0]
        assert "describe this" in state["messages"][0].content

    @patch("app.main.graph")
    def test_null_content_handled(self, mock_graph, client):
        """Null content (tool call results) should not crash."""
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
                "model": "Synesis",
                "messages": [
                    {"role": "assistant", "content": None},
                    {"role": "user", "content": "hi"},
                ],
            },
        )
        assert resp.status_code == 200

    @patch("app.main.graph")
    def test_max_completion_tokens_preferred(self, mock_graph, client):
        """max_completion_tokens takes precedence over max_tokens (OpenAI spec)."""
        mock_graph.ainvoke = AsyncMock(
            return_value={
                "messages": [AIMessage(content="ok")],
                "iteration_count": 1,
                "node_traces": [],
            }
        )
        from app.main import ChatCompletionRequest

        req = ChatCompletionRequest(
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=1000,
            max_completion_tokens=2000,
        )
        assert req.effective_max_tokens == 2000

    def test_max_tokens_fallback(self):
        from app.main import ChatCompletionRequest

        req = ChatCompletionRequest(
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=1500,
        )
        assert req.effective_max_tokens == 1500

    def test_default_max_tokens(self):
        from app.main import ChatCompletionRequest

        req = ChatCompletionRequest(messages=[{"role": "user", "content": "hi"}])
        assert req.effective_max_tokens == 4096


# ---------------------------------------------------------------------------
# Usage and Finish Reason Invariants
# ---------------------------------------------------------------------------


class TestUsageInvariants:
    """Verify usage token math and finish_reason values."""

    @patch("app.main.graph")
    def test_non_streaming_usage_invariants(self, mock_graph, client):
        mock_graph.ainvoke = AsyncMock(
            return_value={
                "messages": [AIMessage(content="Hello from Synesis!")],
                "iteration_count": 1,
                "node_traces": [],
            }
        )
        resp = client.post(
            "/v1/chat/completions",
            json={"model": "Synesis", "messages": [{"role": "user", "content": "hi"}]},
        )
        assert resp.status_code == 200
        usage = resp.json()["usage"]
        assert usage["total_tokens"] >= 0
        if usage["prompt_tokens"] > 0 or usage["completion_tokens"] > 0:
            assert usage["total_tokens"] == usage["prompt_tokens"] + usage["completion_tokens"]
        assert usage["cached_prompt_tokens"] <= max(usage["prompt_tokens"], 0)

    @patch("app.main.graph")
    def test_non_streaming_finish_reason_stop(self, mock_graph, client):
        mock_graph.ainvoke = AsyncMock(
            return_value={
                "messages": [AIMessage(content="answer")],
                "iteration_count": 1,
                "node_traces": [],
            }
        )
        resp = client.post(
            "/v1/chat/completions",
            json={"model": "Synesis", "messages": [{"role": "user", "content": "hi"}]},
        )
        assert resp.status_code == 200
        assert resp.json()["choices"][0]["finish_reason"] == "stop"

    @patch("app.main.graph")
    def test_streaming_usage_on_final_chunk(self, mock_graph, client, monkeypatch):
        _s = planner_settings.model_copy(update={"streaming_events_enabled": False})
        monkeypatch.setattr(planner_main_module, "settings", _s)

        async def mock_astream(init_state, *, stream_mode, config=None):
            yield {"current_node": "entry_classifier", "messages": []}
            yield {"current_node": "respond", "messages": [AIMessage(content="code")]}

        mock_graph.astream = mock_astream
        resp = client.post(
            "/v1/chat/completions",
            json={"model": "Synesis", "messages": [{"role": "user", "content": "hi"}], "stream": True},
        )
        chunks = _sse_completion_chunks(resp.text)
        final = chunks[-1]
        usage = final.get("usage")
        assert usage is not None
        assert usage["total_tokens"] >= 0
        if usage["prompt_tokens"] > 0 or usage["completion_tokens"] > 0:
            assert usage["total_tokens"] == usage["prompt_tokens"] + usage["completion_tokens"]

    def test_build_final_usage_invariants(self):
        """_build_final_usage returns consistent usage math."""
        from app.main import _build_final_usage

        usage = _build_final_usage(
            {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150, "cached_prompt_tokens": 20},
            150,
        )
        assert usage["total_tokens"] == usage["prompt_tokens"] + usage["completion_tokens"]
        assert usage["cached_prompt_tokens"] <= usage["prompt_tokens"]

    def test_build_final_usage_fallback(self):
        from app.main import _build_final_usage

        usage = _build_final_usage(None, 200)
        assert usage["total_tokens"] >= 0


# ---------------------------------------------------------------------------
# LLM Usage Extraction
# ---------------------------------------------------------------------------


class TestLLMUsageExtract:
    """Table-driven tests for normalize_usage_dict correctness."""

    def test_openai_standard(self):
        from app.llm_usage_extract import normalize_usage_dict

        result = normalize_usage_dict({
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "total_tokens": 150,
        })
        assert result.prompt_tokens == 100
        assert result.completion_tokens == 50
        assert result.total_tokens == 150

    def test_openai_with_cached(self):
        from app.llm_usage_extract import normalize_usage_dict

        result = normalize_usage_dict({
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "total_tokens": 150,
            "prompt_tokens_details": {"cached_tokens": 30},
        })
        assert result.cached_prompt_tokens == 30
        assert result.cached_prompt_tokens <= result.prompt_tokens

    def test_anthropic_style(self):
        from app.llm_usage_extract import normalize_usage_dict

        result = normalize_usage_dict({
            "input_tokens": 80,
            "output_tokens": 40,
            "cache_read_input_tokens": 20,
        })
        assert result.prompt_tokens == 80
        assert result.completion_tokens == 40
        assert result.cached_prompt_tokens == 20

    def test_empty_usage(self):
        from app.llm_usage_extract import normalize_usage_dict

        result = normalize_usage_dict(None)
        assert result.prompt_tokens == 0
        assert result.total_tokens == 0

    def test_total_computed_when_missing(self):
        from app.llm_usage_extract import normalize_usage_dict

        result = normalize_usage_dict({"prompt_tokens": 50, "completion_tokens": 25})
        assert result.total_tokens == 75


# ---------------------------------------------------------------------------
# Non-streaming Response Shape
# ---------------------------------------------------------------------------


class TestNonStreamingResponseShape:
    """Verify the full non-streaming response matches OpenAI schema."""

    @patch("app.main.graph")
    def test_full_response_shape(self, mock_graph, client):
        mock_graph.ainvoke = AsyncMock(
            return_value={
                "messages": [AIMessage(content="Hello!")],
                "iteration_count": 1,
                "node_traces": [],
            }
        )
        resp = client.post(
            "/v1/chat/completions",
            json={"model": "Synesis", "messages": [{"role": "user", "content": "hi"}]},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["object"] == "chat.completion"
        assert body["id"].startswith("chatcmpl-")
        assert isinstance(body["created"], int)
        assert body["model"] == "Synesis"
        assert len(body["choices"]) == 1
        choice = body["choices"][0]
        assert choice["index"] == 0
        assert choice["message"]["role"] == "assistant"
        assert choice["message"]["content"] == "Hello!"
        assert choice["finish_reason"] == "stop"
        assert "usage" in body
