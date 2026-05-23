from __future__ import annotations

import pytest


class _Response:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _Client:
    def __init__(self, response: _Response):
        self._response = response

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, *_args, **_kwargs):
        return self._response


@pytest.mark.anyio
async def test_admin_mcp_probe_preserves_not_ready_status(monkeypatch):
    from app.services import mcp_client

    monkeypatch.setattr(mcp_client, "ADMIN_MCP_URL", "http://admin-mcp.local")
    monkeypatch.setattr(
        mcp_client.httpx,
        "AsyncClient",
        lambda: _Client(
            _Response(503, {"status": "not_ready", "checks": {"internal_service_token_configured": False}})
        ),
    )

    result = await mcp_client.probe_admin_mcp_health()

    assert result["reachable"] is False
    assert result["status_code"] == 503
    assert result["url"] == "http://admin-mcp.local/ready"
    assert result["error"] == "not_ready"
