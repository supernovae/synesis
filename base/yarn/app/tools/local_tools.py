"""Built-in local tools available without the MCP server.

These are lightweight tools that run in-process. The synesis_escalate
tool is a special sentinel that triggers LangChain escalation.
"""

from __future__ import annotations

from typing import Any

ESCALATE_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "synesis_escalate",
        "description": (
            "Escalate the current task to the Synesis planner for complex "
            "multi-step reasoning, RAG retrieval, or planning that exceeds "
            "the capabilities of the direct coding loop."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Why escalation is needed",
                },
                "query": {
                    "type": "string",
                    "description": "The query or task to escalate",
                },
            },
            "required": ["reason", "query"],
        },
    },
}

LOCAL_TOOL_DEFINITIONS: list[dict[str, Any]] = [
    ESCALATE_TOOL,
]

LOCAL_TOOL_NAMES: frozenset[str] = frozenset(
    t["function"]["name"] for t in LOCAL_TOOL_DEFINITIONS
)


async def handle_local_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Handle a built-in local tool call.

    Returns a result dict. The synesis_escalate tool returns a special
    sentinel that the orchestrator recognizes.
    """
    if name == "synesis_escalate":
        return {
            "_escalate": True,
            "reason": arguments.get("reason", ""),
            "query": arguments.get("query", ""),
        }

    return {"error": f"Unknown local tool: {name}"}
