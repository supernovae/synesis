"""Client for MCP server tool registry."""

from __future__ import annotations

import logging
import time

import httpx

from ..deps import MCP_URL

logger = logging.getLogger("synesis.admin.mcp")


async def get_mcp_tools() -> list[dict]:
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{MCP_URL.rstrip('/')}/mcp/tools", timeout=5.0)
            resp.raise_for_status()
            data = resp.json()
            tools = data if isinstance(data, list) else data.get("tools", [])
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
                "error": None if ok else (resp.text or "")[:200],
            }
    except Exception as exc:
        ms = round((time.perf_counter() - t0) * 1000, 1)
        return {
            "reachable": False,
            "status_code": None,
            "latency_ms": ms,
            "url": url,
            "error": str(exc)[:200],
        }
