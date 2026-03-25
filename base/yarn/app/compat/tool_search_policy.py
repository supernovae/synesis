"""MCP tool-search policy for Claude Code compatibility.

When ``ANTHROPIC_BASE_URL`` points to a non-first-party host, Claude Code
disables tool search by default because most proxies do not forward
``tool_reference`` blocks.  Synesis Yarn acts as such a proxy.

This module lets the gateway operator choose one of two modes:

  * **passthrough** — preserve ``tool_reference`` and ``defer_loading`` fields
    on tool definitions so upstream tool search works if the downstream
    provider supports it.  The gateway logs a confirmation that pass-through
    is active.

  * **disable** (default) — strip ``tool_reference`` and ``defer_loading``
    from outbound payloads, log a clear message that tool search is disabled,
    and fall back to loading all tool definitions eagerly.

Callers should run ``apply_tool_search_policy`` on the tool list before
sending it downstream.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("yarn.compat.tool_search_policy")


def apply_tool_search_policy(
    tools: list[dict[str, Any]] | None,
    *,
    mode: str = "disable",
    request_id: str = "",
) -> list[dict[str, Any]] | None:
    """Apply the configured tool-search policy to the outbound tool list.

    Returns the (possibly modified) tool list.
    """
    if not tools:
        return tools

    if mode == "passthrough":
        has_refs = any(
            _contains_tool_reference(t)
            for t in tools
            if isinstance(t, dict)
        )
        logger.info(
            "tool_search_passthrough",
            extra={
                "request_id": request_id,
                "tool_count": len(tools),
                "deferred_count": sum(1 for t in tools if isinstance(t, dict) and t.get("defer_loading")),
                "has_tool_references": has_refs,
            },
        )
        return tools

    # mode == "disable" — strip deferred markers and tool_reference blocks
    cleaned: list[dict[str, Any]] = []
    stripped_count = 0
    for tool in tools:
        if not isinstance(tool, dict):
            cleaned.append(tool)
            continue

        out = dict(tool)
        if out.pop("defer_loading", None):
            stripped_count += 1
        _strip_tool_references(out)
        cleaned.append(out)

    if stripped_count:
        logger.info(
            "tool_search_disabled_stripped",
            extra={
                "request_id": request_id,
                "stripped_deferred": stripped_count,
                "tool_count": len(cleaned),
            },
        )
    else:
        logger.debug(
            "tool_search_disabled_noop",
            extra={"request_id": request_id, "tool_count": len(cleaned)},
        )

    return cleaned


def _contains_tool_reference(tool: dict[str, Any]) -> bool:
    content = tool.get("content")
    if isinstance(content, list):
        return any(
            isinstance(b, dict) and b.get("type") == "tool_reference"
            for b in content
        )
    return False


def _strip_tool_references(tool: dict[str, Any]) -> None:
    """Remove ``tool_reference`` blocks from content arrays in-place."""
    content = tool.get("content")
    if isinstance(content, list):
        tool["content"] = [
            b for b in content
            if not (isinstance(b, dict) and b.get("type") == "tool_reference")
        ]
