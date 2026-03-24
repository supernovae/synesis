from __future__ import annotations

import pytest
from app.middleware import auth
from app.tools.orchestrator import ToolOrchestrator
from fastapi import HTTPException
from starlette.requests import Request


def _request_with_auth(value: str | None) -> Request:
    headers = []
    if value is not None:
        headers.append((b"authorization", value.encode()))
    return Request({"type": "http", "headers": headers})


def test_select_active_org_single_org():
    payload = {"organization": {"org-a": {"roles": ["member"]}}}
    org_id, roles = auth._select_active_org(payload)
    assert org_id == "org-a"
    assert roles == ["member"]


def test_select_active_org_multi_org_requires_selection():
    payload = {
        "organization": {
            "org-a": {"roles": ["member"]},
            "org-b": {"roles": ["admin"]},
        }
    }
    with pytest.raises(HTTPException) as exc:
        auth._select_active_org(payload)
    assert exc.value.status_code == 401


def test_select_active_org_uses_requested_org():
    payload = {
        "organization": {
            "org-a": {"roles": ["member"]},
            "org-b": {"roles": ["admin"]},
        }
    }
    org_id, roles = auth._select_active_org(payload, requested_org_id="org-b")
    assert org_id == "org-b"
    assert roles == ["admin"]


@pytest.mark.asyncio
async def test_missing_bearer_token_rejected():
    req = _request_with_auth(None)
    with pytest.raises(HTTPException) as exc:
        await auth.resolve_auth(req)
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_non_pat_requires_keycloak_or_legacy(monkeypatch):
    monkeypatch.setattr(auth.settings, "keycloak_issuer_url", "")
    monkeypatch.setattr(auth.settings, "auth_allow_legacy_fallback", False)
    req = _request_with_auth("Bearer not-a-pat")
    with pytest.raises(HTTPException) as exc:
        await auth.resolve_auth(req)
    assert exc.value.status_code == 401
    assert "Unsupported token type" in exc.value.detail


@pytest.mark.asyncio
async def test_legacy_invalid_token_rejected(monkeypatch):
    monkeypatch.setattr(auth.settings, "keycloak_issuer_url", "")
    monkeypatch.setattr(auth.settings, "auth_allow_legacy_fallback", True)
    req = _request_with_auth("Bearer not-a-real-jwt")
    with pytest.raises(HTTPException) as exc:
        await auth.resolve_auth(req)
    assert exc.value.status_code == 401
    assert exc.value.detail == "Invalid token"


@pytest.mark.asyncio
async def test_orchestrator_blocks_unauthorized_tool():
    orch = ToolOrchestrator()
    result = await orch.execute_tool_call(
        {
            "id": "call-1",
            "function": {"name": "some_mcp_tool", "arguments": "{}"},
        },
        auth_token="token-1",
        allowed_tools={"other_tool"},
    )
    assert result.is_error is True
    assert "not authorized" in result.content
