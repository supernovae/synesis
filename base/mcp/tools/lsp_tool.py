"""MCP Tool: LSP Type Analysis

Provides an MCP-compatible tool definition for running Language Server Protocol
analysis on generated code. Intended for use by Qwen3-Coder via MCP tool
calling, or by OpenWebUI as a tool provider.

Routes analysis requests to the LSP Gateway (base/lsp/gateway/) which supports
Python (pyright), TypeScript (tsserver), Rust (rust-analyzer), Go (gopls),
Java (jdtls), and Bash (shellcheck).

Previously this was a fixed graph node (lsp_analyzer_node). Moved to MCP to
decouple analysis from the planner pipeline and allow on-demand invocation.

Status: STUB — tool schema defined, handler not yet implemented.
"""

from __future__ import annotations

TOOL_SCHEMA = {
    "name": "lsp_analyze",
    "description": (
        "Run LSP (Language Server Protocol) type analysis on code. "
        "Returns diagnostics: errors, warnings, type mismatches, and unused imports. "
        "Supports Python, TypeScript, Rust, Go, Java, and Bash."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": "The code to analyze.",
            },
            "language": {
                "type": "string",
                "enum": ["python", "typescript", "rust", "go", "java", "bash"],
                "description": "Programming language of the code.",
            },
            "filename": {
                "type": "string",
                "description": "Filename hint for the LSP server (e.g. 'main.py').",
                "default": "main",
            },
        },
        "required": ["code", "language"],
    },
}


async def handle(params: dict) -> dict:
    """Execute LSP analysis tool. Not yet implemented — returns stub response."""
    raise NotImplementedError(
        "LSP MCP tool not yet implemented. "
        "See base/mcp/tools/lsp_tool.py for the tool schema. "
        "The LSP Gateway at base/lsp/gateway/ provides the underlying analysis."
    )
