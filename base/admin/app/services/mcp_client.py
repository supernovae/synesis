"""Client for MCP server tool registry."""

from __future__ import annotations

import logging
import time

import httpx

from ..deps import ADMIN_MCP_URL, INTERNAL_SERVICE_TOKEN, MCP_URL
from ..route_validation import validate_safe_identifier
from .admin_mcp_ts_client import build_delegated_cookie_header

logger = logging.getLogger("synesis.admin.mcp")


def _probe_error_from_response(resp: httpx.Response) -> str:
    try:
        payload = resp.json()
    except Exception:
        return "upstream_unhealthy"
    if isinstance(payload, dict):
        if payload.get("status") == "not_ready":
            return "not_ready"
        error = payload.get("error")
        if isinstance(error, str) and error.strip():
            return error.strip()
    return "upstream_unhealthy"


async def get_mcp_tools() -> list[dict]:
    """Catalog from synesis-mcp (Streamable HTTP); public ``GET /v1/synesis-tools``."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{MCP_URL.rstrip('/')}/v1/synesis-tools", timeout=5.0)
            resp.raise_for_status()
            data = resp.json()
            tools = data.get("tools", []) if isinstance(data, dict) else []
            return [
                {
                    "name": t.get("name", ""),
                    "description": t.get("description", ""),
                    "parameters": t.get("inputSchema", t.get("parameters", {})),
                }
                for t in tools
            ]
    except Exception as exc:
        logger.warning("mcp_tools_error error=%s", str(exc)[:80])
        return []


async def probe_mcp_health() -> dict:
    """GET synesis-mcp /health — reachability for Admin Integrations UI."""
    url = f"{MCP_URL.rstrip('/')}/health"
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, timeout=5.0)
            ms = round((time.perf_counter() - t0) * 1000, 1)
            ok = resp.status_code < 400
            return {
                "reachable": ok,
                "status_code": resp.status_code,
                "latency_ms": ms,
                "url": url,
                "error": None if ok else _probe_error_from_response(resp),
            }
    except Exception as exc:
        ms = round((time.perf_counter() - t0) * 1000, 1)
        logger.warning("probe_mcp_health_failed error=%s", str(exc)[:80])
        return {
            "reachable": False,
            "status_code": None,
            "latency_ms": ms,
            "url": url,
            "error": "request_failed",
        }


async def probe_admin_mcp_health() -> dict:
    """GET synesis-admin-mcp-ts /ready — Admin MCP dependency readiness."""
    url = f"{ADMIN_MCP_URL.rstrip('/')}/ready"
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, timeout=5.0)
            ms = round((time.perf_counter() - t0) * 1000, 1)
            ok = resp.status_code < 400
            return {
                "reachable": ok,
                "status_code": resp.status_code,
                "latency_ms": ms,
                "url": url,
                "error": None if ok else _probe_error_from_response(resp),
            }
    except Exception as exc:
        ms = round((time.perf_counter() - t0) * 1000, 1)
        logger.warning("probe_admin_mcp_health_failed error=%s", str(exc)[:80])
        return {
            "reachable": False,
            "status_code": None,
            "latency_ms": ms,
            "url": url,
            "error": "request_failed",
        }


async def get_admin_mcp_tools(
    auth_header: str,
    org_headers: dict[str, str] | None = None,
    *,
    session_cookie: str = "",
    csrf_cookie: str = "",
    csrf_token: str = "",
) -> list[dict]:
    """Catalog from synesis-admin-mcp-ts through the Admin API internal service gate."""
    cookie_header = build_delegated_cookie_header(session_cookie, csrf_cookie)
    if not INTERNAL_SERVICE_TOKEN or not (auth_header.strip() or cookie_header):
        return []
    headers: dict[str, str] = {
        "x-synesis-service-token": INTERNAL_SERVICE_TOKEN,
        "x-synesis-service-name": "synesis-admin",
    }
    if auth_header.strip():
        headers["x-synesis-delegated-authorization"] = auth_header.strip()
    if cookie_header:
        headers["x-synesis-delegated-cookie"] = cookie_header
    if csrf_token.strip():
        headers["x-synesis-delegated-csrf"] = csrf_token.strip()
    if org_headers:
        for key in ("x-synesis-org-id", "x-active-org-id"):
            value = str(org_headers.get(key, "") or "").strip()
            if value:
                headers[key] = validate_safe_identifier(value, field_name=key, max_length=128)
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{ADMIN_MCP_URL.rstrip('/')}/v1/admin-tools", headers=headers, timeout=10.0)
            if resp.status_code in (401, 403):
                return []
            resp.raise_for_status()
            data = resp.json()
            tools = data.get("tools", []) if isinstance(data, dict) else []
            return [
                {
                    "name": t.get("name", ""),
                    "description": t.get("description", ""),
                    "min_role": t.get("min_role", ""),
                    "parameters": t.get("inputSchema", {}),
                }
                for t in tools
                if isinstance(t, dict)
            ]
    except Exception as exc:
        logger.warning("admin_mcp_tools_error error=%s", str(exc)[:120])
        return []
