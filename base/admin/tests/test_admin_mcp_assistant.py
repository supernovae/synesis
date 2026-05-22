"""Admin MCP helpers used by the in-app assistant."""

from __future__ import annotations

import json

import pytest
from app.auth import CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SESSION_COOKIE_NAME, UserInfo
from app.rbac import Role
from app.routers.admin_mcp import invoke_mcp_tool_for_chat, openai_function_tools_for_role
from app.routers.assistant import _extract_trace_lookup_id
from fastapi.testclient import TestClient


def test_openai_tools_respects_role_hierarchy():
    names_readonly = {t["function"]["name"] for t in openai_function_tools_for_role(Role.readonly)}
    names_user = {t["function"]["name"] for t in openai_function_tools_for_role(Role.user)}
    names_org_admin = {t["function"]["name"] for t in openai_function_tools_for_role(Role.org_admin)}
    names_platform = {t["function"]["name"] for t in openai_function_tools_for_role(Role.platform_admin)}

    assert "service_health" in names_readonly
    assert "list_traces" not in names_user
    assert "list_traces" in names_org_admin
    assert "usage_time_series" in names_org_admin
    assert "trace_decision_analytics" in names_org_admin
    assert "yarn_overview" in names_org_admin
    assert "yarn_transition_quality" not in names_org_admin
    assert "yarn_transition_events_tail" not in names_org_admin
    assert "yarn_transition_watch" not in names_org_admin
    assert "yarn_transition_incident_brief" not in names_org_admin
    assert "unified_usage_snapshot" in names_user
    assert "usage_summary" not in names_user
    assert "yarn_transition_quality" not in names_user
    assert "usage_summary" in names_org_admin
    assert "list_traces" not in names_readonly
    assert "yarn_transition_watch" not in names_readonly
    assert "refresh_model_routes" in names_platform
    assert "refresh_model_routes" not in names_user


def test_openai_tools_support_allowlist_restricts_outputs():
    allowed = {"service_health", "unified_usage_snapshot"}
    names = {
        t["function"]["name"] for t in openai_function_tools_for_role(Role.platform_admin, allowed_tool_names=allowed)
    }
    assert names == allowed


def test_extract_trace_lookup_id_from_operator_prompt():
    trace_id = "5f256b3b-2fb3-4196-a707-9d6550b122a6"

    assert _extract_trace_lookup_id(f"Can you summarize the trace for {trace_id} in detail") == trace_id
    assert _extract_trace_lookup_id("Can you summarize this config?") is None


@pytest.mark.asyncio
async def test_invoke_mcp_tool_unknown_returns_json_error():
    user = UserInfo(username="u1", role="user", user_id="u1")
    out = await invoke_mcp_tool_for_chat(user, "no_such_tool", {}, audit_source="test")
    data = json.loads(out)
    assert "error" in data
    assert data.get("tool") == "no_such_tool"


def test_admin_assistant_requires_admin_role():
    from app.auth import get_current_user
    from app.main import app

    async def _override_user() -> UserInfo:
        return UserInfo(username="u1", role="user", user_id="u1")

    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        resp = client.post("/api/v1/assistant/chat", json={"message": "hello"})
        assert resp.status_code == 403
        assert "requires org_admin role" in (resp.json().get("detail") or "")
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_admin_assistant_prefetches_prompt_trace_id_via_admin_mcp(monkeypatch):
    from app.auth import get_current_user
    from app.main import app

    trace_id = "5f256b3b-2fb3-4196-a707-9d6550b122a6"
    captured_payload: dict = {}

    async def _override_user() -> UserInfo:
        return UserInfo(username="admin", role="org_admin", user_id="u1", org_id="org-1")

    async def _fake_list_tools(*_args, **_kwargs):
        return []

    async def _fake_invoke_tool(_auth_header, _org_headers, tool_name, arguments, **kwargs):
        assert tool_name == "get_trace"
        assert arguments == {"trace_id": trace_id}
        assert kwargs["session_cookie"] == "a" * 43
        return json.dumps(
            {
                "trace_id": trace_id,
                "query_snippet": "Why did the admin assistant lose MCP trace access?",
                "total_duration_ms": 1234,
                "total_tokens": 4567,
                "difficulty": 0.6,
                "has_error": False,
                "spans": [
                    {"intent": "trace_lookup", "latency_ms": 55, "tokens_used": 120},
                    {"intent": "summarize", "latency_ms": 90, "tokens_used": 180},
                ],
            }
        )

    class _Resp:
        @staticmethod
        def raise_for_status():
            return None

        @staticmethod
        def json():
            return {
                "choices": [{"message": {"content": "Trace summary ok"}}],
                "usage": {"total_tokens": 11},
                "model": "test-model",
            }

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, *args, **kwargs):
            captured_payload.update(kwargs.get("json") or {})
            return _Resp()

    monkeypatch.setattr("app.routers.assistant.list_admin_mcp_tools", _fake_list_tools)
    monkeypatch.setattr("app.routers.assistant.invoke_admin_mcp_tool", _fake_invoke_tool)
    monkeypatch.setattr("app.routers.assistant.httpx.AsyncClient", lambda timeout=120.0: _Client())
    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        client.cookies.set(SESSION_COOKIE_NAME, "a" * 43)
        client.cookies.set(CSRF_COOKIE_NAME, "b" * 64)
        resp = client.post(
            "/api/v1/assistant/chat",
            json={"message": f"Can you summarize the trace for {trace_id} in detail"},
            headers={CSRF_HEADER_NAME: "b" * 64},
        )
        assert resp.status_code == 200
        assert resp.json()["response"] == "Trace summary ok"
        prompt = captured_payload["messages"][1]["content"]
        assert "Admin MCP get_trace result" in prompt
        assert trace_id in prompt
        assert "trace_lookup" in prompt
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_admin_assistant_executes_planner_tool_calls(monkeypatch):
    from app.auth import get_current_user
    from app.main import app

    calls: list[dict] = []
    invoked_tools: list[str] = []

    async def _override_user() -> UserInfo:
        return UserInfo(username="admin", role="org_admin", user_id="u1", org_id="org-1")

    async def _fake_list_tools(*_args, **_kwargs):
        return [
            {
                "name": "service_health",
                "description": "Return service health",
                "inputSchema": {"type": "object", "properties": {}},
            }
        ]

    async def _fake_invoke_tool(_auth_header, _org_headers, tool_name, arguments, **kwargs):
        invoked_tools.append(tool_name)
        assert tool_name == "service_health"
        assert arguments == {}
        assert kwargs["session_cookie"] == "a" * 43
        return json.dumps({"status": "ok", "service": "admin-mcp-ts"})

    class _Resp:
        def __init__(self, payload):
            self._payload = payload

        @staticmethod
        def raise_for_status():
            return None

        def json(self):
            return self._payload

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, *args, **kwargs):
            calls.append(kwargs.get("json") or {})
            if len(calls) == 1:
                return _Resp(
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": None,
                                    "tool_calls": [
                                        {
                                            "id": "call_1",
                                            "type": "function",
                                            "function": {"name": "service_health", "arguments": "{}"},
                                        }
                                    ],
                                }
                            }
                        ],
                        "usage": {"total_tokens": 7},
                        "model": "test-model",
                    }
                )
            return _Resp(
                {
                    "choices": [{"message": {"content": "Admin MCP health is ok."}}],
                    "usage": {"total_tokens": 11},
                    "model": "test-model",
                }
            )

    monkeypatch.setattr("app.routers.assistant.list_admin_mcp_tools", _fake_list_tools)
    monkeypatch.setattr("app.routers.assistant.invoke_admin_mcp_tool", _fake_invoke_tool)
    monkeypatch.setattr("app.routers.assistant.httpx.AsyncClient", lambda timeout=120.0: _Client())
    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        client.cookies.set(SESSION_COOKIE_NAME, "a" * 43)
        client.cookies.set(CSRF_COOKIE_NAME, "b" * 64)
        resp = client.post(
            "/api/v1/assistant/chat",
            json={"message": "Check the live service health"},
            headers={CSRF_HEADER_NAME: "b" * 64},
        )
        assert resp.status_code == 200
        assert resp.json()["response"] == "Admin MCP health is ok."
        assert resp.json()["tool_rounds"] == 1
        assert invoked_tools == ["service_health"]
        assert calls[0]["tools"][0]["function"]["name"] == "service_health"
        assert calls[1]["messages"][-1] == {
            "role": "tool",
            "tool_call_id": "call_1",
            "content": '{"status": "ok", "service": "admin-mcp-ts"}',
        }
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_support_assistant_accepts_user_role(monkeypatch):
    from app.auth import get_current_user
    from app.main import app

    class _Resp:
        @staticmethod
        def raise_for_status():
            return None

        @staticmethod
        def json():
            return {
                "choices": [{"message": {"content": "ok"}}],
                "usage": {"total_tokens": 5},
                "model": "test-model",
            }

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, *args, **kwargs):
            return _Resp()

    async def _override_user() -> UserInfo:
        return UserInfo(username="u1", role="user", user_id="u1")

    monkeypatch.setattr("app.routers.assistant.httpx.AsyncClient", lambda timeout=120.0: _Client())
    app.dependency_overrides[get_current_user] = _override_user
    try:
        client = TestClient(app)
        resp = client.post("/api/v1/assistant/support/chat", json={"message": "hello"})
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("response") == "ok"
        assert data.get("tokens") == 5
    finally:
        app.dependency_overrides.pop(get_current_user, None)
