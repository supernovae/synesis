"""Async client for the existing Synesis MCP server."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..config import settings

logger = logging.getLogger("yarn.tools.mcp")

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=settings.mcp_url,
            timeout=60.0,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _client


async def list_tools() -> list[dict[str, Any]]:
    """Fetch available tools from the MCP server."""
    client = _get_client()
    try:
        resp = await client.get("/mcp/tools")
        resp.raise_for_status()
        data = resp.json()
        return data.get("tools", [])
    except Exception:
        logger.exception("Failed to list MCP tools")
        return []


async def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Execute a tool on the MCP server."""
    client = _get_client()
    resp = await client.post(
        "/mcp/tools/call",
        json={"name": name, "arguments": arguments},
    )
    resp.raise_for_status()
    return resp.json()


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
