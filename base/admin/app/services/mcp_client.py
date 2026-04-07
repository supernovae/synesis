"""Client for MCP server tool registry."""

from __future__ import annotations

import logging
import time

import httpx

from ..deps import ADMIN_MCP_URL, MCP_URL

logger = logging.getLogger("synesis.admin.mcp")


async def get_mcp_tools() -> list[dict]:
    """Catalog from synesis-mcp-ts (Streamable HTTP); public ``GET /v1/synesis-tools``."""
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
    """GET synesis-mcp-ts /health — reachability for Admin Integrations UI."""
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
                "error": None if ok else "upstream_unhealthy",
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
    """GET synesis-admin-mcp-ts /health — Admin MCP (Streamable HTTP) reachability."""
    url = f"{ADMIN_MCP_URL.rstrip('/')}/health"
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
                "error": None if ok else "upstream_unhealthy",
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
