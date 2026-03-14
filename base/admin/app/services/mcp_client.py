"""Client for MCP server tool registry."""

from __future__ import annotations

import logging

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
