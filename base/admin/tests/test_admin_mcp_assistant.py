"""Admin MCP helpers used by the in-app assistant."""

from __future__ import annotations

import json

import pytest
from app.auth import UserInfo
from app.rbac import Role
from app.routers.admin_mcp import invoke_mcp_tool_for_chat, openai_function_tools_for_role
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
