"""Tool call orchestrator — the hot loop's tool execution engine.

Handles MCP tools and local tools with schema validation, retries,
and structured error handling. No LangChain dependency.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from . import mcp_client
from .local_tools import LOCAL_TOOL_DEFINITIONS, LOCAL_TOOL_NAMES, handle_local_tool
from .schema_validator import ToolValidationError, validate_tool_args

logger = logging.getLogger("yarn.tools.orchestrator")


class ToolResult:
    __slots__ = ("tool_call_id", "name", "content", "is_error", "escalate", "escalate_query")

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
        self._max_retries = max_retries
        self._initialized = False

    async def initialize(self) -> None:
        """Load tool definitions from MCP server."""
        if self._initialized:
            return
        tools = await mcp_client.list_tools()
        for tool in tools:
            name = tool.get("name", "")
            if name:
                self._mcp_tools[name] = tool
        self._initialized = True
        logger.info("Loaded %d MCP tools", len(self._mcp_tools))

    def list_tools(self) -> list[dict[str, Any]]:
        """Return all available tools in OpenAI function-calling format."""
        tools: list[dict[str, Any]] = []

        for tool in self._mcp_tools.values():
            tools.append({
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "parameters": tool.get("inputSchema", {}),
                },
            })

        tools.extend(LOCAL_TOOL_DEFINITIONS)
        return tools

    def register_tool(self, tool_def: dict[str, Any]) -> None:
        """Register an additional tool at runtime."""
        name = tool_def.get("name", "")
        if name:
            self._mcp_tools[name] = tool_def

    async def execute_tool_call(self, call: dict[str, Any]) -> ToolResult:
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
        schema = self._mcp_tools.get(name, {})
        if schema:
            try:
                args = validate_tool_args(name, args, schema)
            except ToolValidationError as e:
                return ToolResult(call_id, name, str(e), is_error=True)

        # Route to handler
        if name in LOCAL_TOOL_NAMES:
            return await self._execute_local(call_id, name, args)
        if name in self._mcp_tools:
            return await self._execute_mcp(call_id, name, args)

        return ToolResult(call_id, name, f"Unknown tool: {name}", is_error=True)

    async def _execute_local(
        self, call_id: str, name: str, args: dict[str, Any]
    ) -> ToolResult:
        try:
            result = await handle_local_tool(name, args)
            if result.get("_escalate"):
                return ToolResult(
                    call_id, name, "Escalation requested",
                    escalate=True,
                    escalate_query=result.get("query", ""),
                )
            return ToolResult(call_id, name, json.dumps(result))
        except Exception as e:
            logger.exception("Local tool %s failed", name)
            return ToolResult(call_id, name, f"Error: {e}", is_error=True)

    async def _execute_mcp(
        self, call_id: str, name: str, args: dict[str, Any]
    ) -> ToolResult:
        last_error = ""
        for attempt in range(self._max_retries + 1):
            try:
                result = await mcp_client.call_tool(name, args)
                content_parts = result.get("content", [])
                text = "\n".join(
                    p.get("text", str(p)) for p in content_parts
                ) if isinstance(content_parts, list) else str(content_parts)
                return ToolResult(call_id, name, text)
            except Exception as e:
                last_error = str(e)
                if attempt < self._max_retries:
                    logger.warning(
                        "MCP tool %s attempt %d failed: %s", name, attempt + 1, e
                    )
                    continue
                break

        logger.error("MCP tool %s failed after %d attempts", name, self._max_retries + 1)
        return ToolResult(call_id, name, f"Error after retries: {last_error}", is_error=True)
