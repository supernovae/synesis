"""Admin MCP helpers used by the in-app assistant."""

from __future__ import annotations

import json

import pytest
from app.auth import UserInfo
from app.rbac import Role
from app.routers.admin_mcp import invoke_mcp_tool_for_chat, openai_function_tools_for_role


def test_openai_tools_respects_role_hierarchy():
    names_readonly = {t["function"]["name"] for t in openai_function_tools_for_role(Role.readonly)}
    names_user = {t["function"]["name"] for t in openai_function_tools_for_role(Role.user)}
    names_platform = {t["function"]["name"] for t in openai_function_tools_for_role(Role.platform_admin)}

    assert "service_health" in names_readonly
    assert "list_traces" in names_user
    assert "unified_usage_snapshot" in names_user
    assert "list_traces" not in names_readonly
    assert "trigger_usage_rollup" in names_platform
    assert "trigger_usage_rollup" not in names_user


@pytest.mark.asyncio
async def test_invoke_mcp_tool_unknown_returns_json_error():
    user = UserInfo(username="u1", role="user", user_id="u1")
    out = await invoke_mcp_tool_for_chat(user, "no_such_tool", {}, audit_source="test")
    data = json.loads(out)
    assert "error" in data
    assert data.get("tool") == "no_such_tool"
