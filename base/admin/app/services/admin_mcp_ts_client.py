"""HTTP client for synesis-admin-mcp-ts tool catalog and invocation."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx

from ..auth import CSRF_COOKIE_NAME, SESSION_COOKIE_NAME
from ..deps import ADMIN_MCP_URL, INTERNAL_SERVICE_TOKEN
from ..route_validation import validate_safe_identifier

logger = logging.getLogger("synesis.admin.mcp.ts_client")

_SESSION_COOKIE_VALUE_RE = re.compile(r"^[A-Za-z0-9_-]{32,256}$")
_CSRF_COOKIE_VALUE_RE = re.compile(r"^[A-Fa-f0-9]{32,128}$")
_SENSITIVE_ARG_PARTS = ("token", "secret", "password", "authorization", "cookie", "session", "key")


def _redact_tool_arguments(value: Any, depth: int = 0) -> Any:
    """Best-effort redaction for MCP tool argument audit records."""
    if depth > 4:
        return "<redacted:nested>"
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if any(part in key_text.lower() for part in _SENSITIVE_ARG_PARTS):
                out[key_text] = "<redacted>"
            else:
                out[key_text] = _redact_tool_arguments(item, depth + 1)
        return out
    if isinstance(value, list):
        return [_redact_tool_arguments(item, depth + 1) for item in value[:25]]
    if isinstance(value, str):
        return value[:500]
    return value


def build_delegated_cookie_header(session_cookie: str = "", csrf_cookie: str = "") -> str:
    """Return a minimal internal Cookie header for Admin API session validation."""
    session_value = session_cookie.strip()
    csrf_value = csrf_cookie.strip()
    parts: list[str] = []
    if _SESSION_COOKIE_VALUE_RE.fullmatch(session_value):
        parts.append(f"{SESSION_COOKIE_NAME}={session_value}")
    if _CSRF_COOKIE_VALUE_RE.fullmatch(csrf_value):
        parts.append(f"{CSRF_COOKIE_NAME}={csrf_value}")
    return "; ".join(parts)


def _clean_org_headers(org_headers: dict[str, str] | None) -> dict[str, str]:
    if not org_headers:
        return {}
    out: dict[str, str] = {}
    for key in ("x-synesis-org-id", "x-active-org-id"):
        value = str(org_headers.get(key, "") or "").strip()
        if value:
            out[key] = validate_safe_identifier(value, field_name=key, max_length=128)
    return out


def _base_headers(
    auth_header: str = "",
    org_headers: dict[str, str] | None = None,
    *,
    session_cookie: str = "",
    csrf_cookie: str = "",
    csrf_token: str = "",
) -> dict[str, str]:
    headers: dict[str, str] = {
        "x-synesis-service-name": "synesis-admin",
    }
    if INTERNAL_SERVICE_TOKEN:
        headers["x-synesis-service-token"] = INTERNAL_SERVICE_TOKEN
    if auth_header.strip():
        headers["x-synesis-delegated-authorization"] = auth_header.strip()
    cookie_header = build_delegated_cookie_header(session_cookie, csrf_cookie)
    if cookie_header.strip():
        headers["x-synesis-delegated-cookie"] = cookie_header
    if csrf_token.strip():
        headers["x-synesis-delegated-csrf"] = csrf_token.strip()
    headers.update(_clean_org_headers(org_headers))
    return headers


async def list_admin_mcp_tools(
    auth_header: str = "",
    org_headers: dict[str, str] | None = None,
    *,
    session_cookie: str = "",
    csrf_cookie: str = "",
    csrf_token: str = "",
) -> list[dict[str, Any]]:
    if not INTERNAL_SERVICE_TOKEN:
        logger.warning("admin_mcp_internal_token_missing")
        return []
    url = f"{ADMIN_MCP_URL.rstrip('/')}/v1/admin-tools"
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(
            url,
            headers=_base_headers(
                auth_header,
                org_headers,
                session_cookie=session_cookie,
                csrf_cookie=csrf_cookie,
                csrf_token=csrf_token,
            ),
        )
    if resp.status_code in (401, 403):
        raise PermissionError(f"admin_mcp_catalog_{resp.status_code}")
    resp.raise_for_status()
    payload = resp.json()
    tools = payload.get("tools") if isinstance(payload, dict) else None
    if not isinstance(tools, list):
        return []
    out: list[dict[str, Any]] = []
    for item in tools:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        out.append(
            {
                "name": name,
                "description": str(item.get("description", "") or ""),
                "inputSchema": item.get("inputSchema")
                if isinstance(item.get("inputSchema"), dict)
                else {"type": "object", "properties": {}},
                "min_role": str(item.get("min_role", "") or ""),
            }
        )
    return out


def openai_function_tools_from_admin_mcp_catalog(
    tools: list[dict[str, Any]],
    *,
    allowed_tool_names: set[str] | None = None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for tool in tools:
        name = str(tool.get("name", "")).strip()
        if not name:
            continue
        if allowed_tool_names is not None and name not in allowed_tool_names:
            continue
        out.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": str(tool.get("description", "") or ""),
                    "parameters": tool.get("inputSchema")
                    if isinstance(tool.get("inputSchema"), dict)
                    else {"type": "object", "properties": {}},
                },
            }
        )
    return out


async def invoke_admin_mcp_tool(
    auth_header: str,
    org_headers: dict[str, str] | None,
    tool_name: str,
    arguments: dict[str, Any],
    *,
    session_cookie: str = "",
    csrf_cookie: str = "",
    csrf_token: str = "",
) -> str:
    if not INTERNAL_SERVICE_TOKEN:
        return json.dumps({"error": "admin_mcp_not_configured", "tool": tool_name})
    url = f"{ADMIN_MCP_URL.rstrip('/')}/v1/admin-tools/invoke"
    body = {"name": tool_name, "arguments": arguments}
    headers = _base_headers(
        auth_header,
        org_headers,
        session_cookie=session_cookie,
        csrf_cookie=csrf_cookie,
        csrf_token=csrf_token,
    )
    headers["Content-Type"] = "application/json"
    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            resp = await client.post(url, headers=headers, json=body)
        payload = resp.json()
        if resp.status_code in (401, 403):
            return json.dumps({"error": "forbidden", "tool": tool_name, "status_code": resp.status_code})
        if resp.status_code == 404:
            return json.dumps({"error": "tool_not_found", "tool": tool_name})
        if resp.status_code >= 400:
            code = payload.get("error") if isinstance(payload, dict) else "tool_failed"
            return json.dumps({"error": str(code or "tool_failed"), "tool": tool_name, "status_code": resp.status_code})
        if isinstance(payload, dict) and "result" in payload:
            return json.dumps(payload["result"], default=str)
        return json.dumps(payload, default=str)
    except Exception:
        logger.warning("admin_mcp_ts_invoke_failed tool=%s", tool_name, exc_info=True)
        return json.dumps({"error": "admin_mcp_request_failed", "tool": tool_name})
