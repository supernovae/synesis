"""Tool call orchestrator — the hot loop's tool execution engine.

Handles MCP tools and local tools with schema validation, retries,
and structured error handling. No LangChain dependency.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from . import mcp_client
from .local_tools import LOCAL_TOOL_DEFINITIONS, LOCAL_TOOL_NAMES, handle_local_tool
from .schema_validator import ToolValidationError, validate_tool_args

logger = logging.getLogger("yarn.tools.orchestrator")


class ToolResult:
    __slots__ = ("content", "escalate", "escalate_query", "is_error", "name", "tool_call_id")

    def __init__(
        self,
        tool_call_id: str,
        name: str,
        content: str,
        is_error: bool = False,
        escalate: bool = False,
        escalate_query: str = "",
    ):
        self.tool_call_id = tool_call_id
        self.name = name
        self.content = content
        self.is_error = is_error
        self.escalate = escalate
        self.escalate_query = escalate_query


class ToolOrchestrator:
    """Manages tool registration, validation, and execution."""

    def __init__(self, max_retries: int = 2):
        self._mcp_tools: dict[str, dict[str, Any]] = {}
        self._mcp_tool_cache: dict[str, tuple[float, dict[str, dict[str, Any]]]] = {}
        self._max_retries = max_retries
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize local orchestrator state.

        User-scoped MCP tools are loaded lazily per authenticated request.
        """
        if self._initialized:
            return
        self._initialized = True
        logger.info("Tool orchestrator initialized")

    def _format_tools(self, mcp_tools: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        """Return all available tools in OpenAI function-calling format."""
        tools: list[dict[str, Any]] = []

        for tool in mcp_tools.values():
            tools.append(
                {
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": tool.get("description", ""),
                        "parameters": tool.get("inputSchema", {}),
                    },
                }
            )

        tools.extend(LOCAL_TOOL_DEFINITIONS)
        return tools

    def list_tools(self) -> list[dict[str, Any]]:
        return self._format_tools(self._mcp_tools)

    async def load_tools_for_token(self, auth_token: str) -> list[dict[str, Any]]:
        """Load role-filtered MCP tools for an authenticated caller."""
        now = time.time()
        cache_key = auth_token[-12:]
        cached = self._mcp_tool_cache.get(cache_key)
        if cached and (now - cached[0]) < 60.0:
            return self._format_tools(cached[1])

        remote_tools = await mcp_client.list_tools_authorized(auth_token)
        scoped: dict[str, dict[str, Any]] = {}
        for tool in remote_tools:
            name = tool.get("name", "")
            if name:
                scoped[name] = tool
        self._mcp_tool_cache[cache_key] = (now, scoped)
        return self._format_tools(scoped)

    def register_tool(self, tool_def: dict[str, Any]) -> None:
        """Register an additional tool at runtime."""
        name = tool_def.get("name", "")
        if name:
            self._mcp_tools[name] = tool_def

    def _tools_for_token(self, auth_token: str) -> dict[str, dict[str, Any]]:
        if not auth_token:
            return self._mcp_tools
        cache_key = auth_token[-12:]
        cached = self._mcp_tool_cache.get(cache_key)
        if cached:
            return cached[1]
        return {}

    async def execute_tool_call(
        self,
        call: dict[str, Any],
        *,
        auth_token: str = "",
        allowed_tools: set[str] | None = None,
    ) -> ToolResult:
        """Execute a single tool call with validation and retries."""
        func = call.get("function", {})
        name = func.get("name", "")
        raw_args = func.get("arguments", "{}")
        call_id = call.get("id", "")

        # Parse arguments
        try:
            if isinstance(raw_args, str):
                args = json.loads(raw_args) if raw_args else {}
            else:
                args = raw_args
        except json.JSONDecodeError as e:
            return ToolResult(call_id, name, f"Invalid JSON arguments: {e}", is_error=True)

        # Validate against schema
        tool_map = self._tools_for_token(auth_token)
        schema = tool_map.get(name, {})
        if schema:
            try:
                args = validate_tool_args(name, args, schema)
            except ToolValidationError as e:
                return ToolResult(call_id, name, str(e), is_error=True)

        # Route to handler
        if name in LOCAL_TOOL_NAMES:
            return await self._execute_local(call_id, name, args)
        if allowed_tools is not None and name not in allowed_tools:
            logger.warning("Blocked unauthorized MCP tool call: %s", name)
            return ToolResult(call_id, name, "Tool is not authorized for caller", is_error=True)
        if name in tool_map:
            return await self._execute_mcp(call_id, name, args, auth_token=auth_token)

        return ToolResult(call_id, name, f"Unknown tool: {name}", is_error=True)

    async def _execute_local(self, call_id: str, name: str, args: dict[str, Any]) -> ToolResult:
        try:
            result = await handle_local_tool(name, args)
            if result.get("_escalate"):
                return ToolResult(
                    call_id,
                    name,
                    "Escalation requested",
                    escalate=True,
                    escalate_query=result.get("query", ""),
                )
            return ToolResult(call_id, name, json.dumps(result))
        except Exception as e:
            logger.exception("Local tool %s failed", name)
            return ToolResult(call_id, name, f"Error: {e}", is_error=True)

    async def _execute_mcp(self, call_id: str, name: str, args: dict[str, Any], *, auth_token: str = "") -> ToolResult:
        last_error = ""
        for attempt in range(self._max_retries + 1):
            try:
                if auth_token:
                    result = await mcp_client.call_tool_authorized(name, args, auth_token=auth_token)
                else:
                    result = await mcp_client.call_tool(name, args)
                content_parts = result.get("content", [])
                text = (
                    "\n".join(p.get("text", str(p)) for p in content_parts)
                    if isinstance(content_parts, list)
                    else str(content_parts)
                )
                return ToolResult(call_id, name, text)
            except Exception as e:
                last_error = str(e)
                if attempt < self._max_retries:
                    logger.warning("MCP tool %s attempt %d failed: %s", name, attempt + 1, e)
                    continue
                break

        logger.error("MCP tool %s failed after %d attempts", name, self._max_retries + 1)
        return ToolResult(call_id, name, f"Error after retries: {last_error}", is_error=True)
