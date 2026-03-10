"""MCP Tool: Sandbox Code Execution

Provides an MCP-compatible tool definition for running generated code in an
isolated OpenShift sandbox pod. Intended for use by Qwen3-Coder via MCP
tool calling, or by OpenWebUI as a tool provider.

The sandbox creates an ephemeral K8s Job in the synesis-sandbox namespace with
deny-all networking, restricted SCC, and no privilege escalation. The Job runs
linting, security scanning, and code execution, returning structured JSON.

Previously this was a fixed graph node (executor.py / sandbox_node). Moved to
MCP to decouple execution from the planner pipeline and allow on-demand
invocation by any MCP-capable client.

Status: STUB — tool schema defined, handler not yet implemented.
"""

from __future__ import annotations

TOOL_SCHEMA = {
    "name": "sandbox_execute",
    "description": (
        "Execute code in an isolated Kubernetes sandbox pod. "
        "Runs linting (shellcheck/ruff), security scanning (bandit), and the code itself. "
        "Returns structured JSON with exit_code, stdout, stderr, lint_passed, security_passed."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": "The code to execute.",
            },
            "language": {
                "type": "string",
                "enum": ["python", "bash", "typescript", "go", "rust", "java"],
                "description": "Programming language of the code.",
            },
            "timeout_seconds": {
                "type": "integer",
                "default": 30,
                "description": "Maximum execution time in seconds.",
            },
            "include_lint": {
                "type": "boolean",
                "default": True,
                "description": "Run linter before execution.",
            },
            "include_security_scan": {
                "type": "boolean",
                "default": True,
                "description": "Run security scanner (bandit/semgrep) before execution.",
            },
        },
        "required": ["code", "language"],
    },
}


async def handle(params: dict) -> dict:
    """Execute sandbox tool. Not yet implemented — returns stub response."""
    raise NotImplementedError(
        "Sandbox MCP tool not yet implemented. See base/mcp/tools/sandbox_tool.py for the tool schema."
    )
