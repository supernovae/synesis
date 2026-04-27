"""HTTP client for synesis-admin-mcp-ts tool catalog and invocation."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from ..deps import ADMIN_MCP_URL

logger = logging.getLogger("synesis.admin.mcp.ts_client")


def _clean_org_headers(org_headers: dict[str, str] | None) -> dict[str, str]:
    if not org_headers:
        return {}
    out: dict[str, str] = {}
    for key in ("x-synesis-org-id", "x-active-org-id"):
        value = str(org_headers.get(key, "") or "").strip()
        if value:
            out[key] = value
    return out


def _base_headers(auth_header: str, org_headers: dict[str, str] | None = None) -> dict[str, str]:
    headers: dict[str, str] = {"Authorization": auth_header}
    headers.update(_clean_org_headers(org_headers))
    return headers


async def list_admin_mcp_tools(
    auth_header: str,
    org_headers: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    url = f"{ADMIN_MCP_URL.rstrip('/')}/v1/admin-tools"
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(url, headers=_base_headers(auth_header, org_headers))
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
) -> str:
    url = f"{ADMIN_MCP_URL.rstrip('/')}/v1/admin-tools/invoke"
    body = {"name": tool_name, "arguments": arguments}
    headers = _base_headers(auth_header, org_headers)
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
            detail = payload.get("detail") if isinstance(payload, dict) else payload
            return json.dumps({"error": str(detail), "tool": tool_name, "status_code": resp.status_code})
        if isinstance(payload, dict) and "result" in payload:
            return json.dumps(payload["result"], default=str)
        return json.dumps(payload, default=str)
    except Exception as exc:
        logger.warning("admin_mcp_ts_invoke_failed tool=%s", tool_name, exc_info=True)
        return json.dumps({"error": str(exc), "tool": tool_name})
