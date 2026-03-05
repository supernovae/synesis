"""Synesis MCP Server — exposes Synesis intelligence as MCP tools.

Implements the Model Context Protocol (MCP, Linux Foundation standard) to let
IDE coding agents (Qwen3-Coder-Next via Cursor, Claude Code, etc.) invoke
Synesis capabilities without going through the full LangGraph pipeline.

MCP primitives exposed:
  Tools:     classify, plan, critique, search
  Resources: taxonomy/{domain}, history/{user_id}
  Prompts:   architecture-review, security-audit, code-review

Runs as a standalone FastAPI service on port 8100.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logging.basicConfig(
    level=getattr(logging, os.environ.get("SYNESIS_LOG_LEVEL", "info").upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("synesis.mcp")

PLANNER_URL = os.environ.get(
    "SYNESIS_PLANNER_URL",
    "http://synesis-planner.synesis-planner.svc.cluster.local:8000",
)
CRITIC_URL = os.environ.get(
    "SYNESIS_CRITIC_URL",
    "http://synesis-executor-predictor.synesis-models.svc.cluster.local:8080/v1",
)
CRITIC_MODEL = os.environ.get("SYNESIS_CRITIC_MODEL", "synesis-executor")

app = FastAPI(title="Synesis MCP Server", version="0.1.0")


# ---------------------------------------------------------------------------
# MCP Tool Registry
# ---------------------------------------------------------------------------
from .tools import cve_lookup, documentation, license_compliance

TOOLS: list[dict[str, Any]] = [
    {
        "name": "synesis_classify",
        "description": (
            "Classify a task description. Returns intent_class, is_code_task, "
            "difficulty (0.0-1.0), task_size (easy/medium/hard), and taxonomy metadata."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "The task or prompt to classify"},
            },
            "required": ["task"],
        },
    },
    {
        "name": "synesis_plan",
        "description": (
            "Generate an execution plan for a complex task. Returns structured "
            "steps, touched files, open questions, and risk assessment."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "The task to plan for"},
                "language": {"type": "string", "description": "Target language", "default": "python"},
                "context": {"type": "string", "description": "Additional context (file contents, etc.)"},
            },
            "required": ["task"],
        },
    },
    {
        "name": "synesis_critique",
        "description": (
            "Submit code for R1 critic review. Returns approval status, "
            "blocking issues, what-if analyses, and improvement suggestions."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "Code to review"},
                "task": {"type": "string", "description": "What the code is supposed to do"},
                "language": {"type": "string", "description": "Programming language", "default": "python"},
            },
            "required": ["code", "task"],
        },
    },
    {
        "name": "synesis_search",
        "description": (
            "RAG retrieval against the Synesis knowledge catalog. Returns "
            "ranked chunks with provenance and relevance scores."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "collection": {"type": "string", "description": "Collection to search", "default": "synesis_catalog"},
                "top_k": {"type": "integer", "description": "Number of results", "default": 5},
            },
            "required": ["query"],
        },
    },
]


# ---------------------------------------------------------------------------
# MCP Endpoints (SSE transport for MCP SDK compatibility)
# ---------------------------------------------------------------------------
@app.get("/mcp/tools")
async def list_tools():
    """MCP tools/list — returns available tools."""
    return {"tools": TOOLS}


@app.post("/mcp/tools/call")
async def call_tool(request: Request):
    """MCP tools/call — execute a tool by name."""
    body = await request.json()
    tool_name = body.get("name", "")
    arguments = body.get("arguments", {})

    handler = _TOOL_HANDLERS.get(tool_name)
    if not handler:
        return JSONResponse(
            status_code=404,
            content={"error": f"Unknown tool: {tool_name}"},
        )

    try:
        result = await handler(arguments)
        return {"content": [{"type": "text", "text": str(result)}]}
    except Exception as e:
        logger.error("Tool %s failed: %s", tool_name, e, exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"error": str(e)},
        )


# ---------------------------------------------------------------------------
# Tool Implementations
# ---------------------------------------------------------------------------
async def _classify(args: dict[str, Any]) -> dict[str, Any]:
    """Invoke planner's entry classifier via internal API."""
    task = args["task"]
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{PLANNER_URL}/v1/chat/completions",
            json={
                "model": "synesis-agent",
                "messages": [{"role": "user", "content": task}],
                "stream": False,
                "max_tokens": 1,
            },
            headers={"X-Synesis-MCP": "classify-only"},
        )
        resp.raise_for_status()
        return resp.json()


async def _plan(args: dict[str, Any]) -> dict[str, Any]:
    """Generate execution plan via planner pipeline."""
    task = args["task"]
    context = args.get("context", "")
    prompt = task
    if context:
        prompt = f"{task}\n\nContext:\n{context}"

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{PLANNER_URL}/v1/chat/completions",
            json={
                "model": "synesis-agent",
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "max_tokens": 4096,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        return {"plan": content}


async def _critique(args: dict[str, Any]) -> dict[str, Any]:
    """Submit code to R1 critic for review."""
    code = args["code"]
    task = args["task"]
    language = args.get("language", "python")

    system_prompt = (
        "You are a code critic. Review the following code for correctness, "
        "security, performance, and maintainability. Identify blocking issues "
        "and provide actionable suggestions. Be specific and reference line "
        "numbers where possible.\n\n"
        f"Task: {task}\nLanguage: {language}"
    )

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{CRITIC_URL}/chat/completions",
            json={
                "model": CRITIC_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": f"```{language}\n{code}\n```"},
                ],
                "temperature": 0.1,
                "max_tokens": 4096,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        review = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        return {"review": review}


async def _search(args: dict[str, Any]) -> dict[str, Any]:
    """RAG retrieval against Synesis catalog."""
    query = args["query"]
    top_k = args.get("top_k", 5)

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{PLANNER_URL}/v1/knowledge/search",
            json={"query": query, "top_k": top_k},
        )
        if resp.status_code == 404:
            return {"results": [], "note": "Knowledge search endpoint not yet available"}
        resp.raise_for_status()
        return resp.json()


_TOOL_HANDLERS = {
    "synesis_classify": _classify,
    "synesis_plan": _plan,
    "synesis_critique": _critique,
    "synesis_search": _search,
    "synesis_license_check": license_compliance.handle,
    "synesis_cve_check": cve_lookup.handle,
    "synesis_docs_lookup": documentation.handle,
}

# Register additional tool definitions
TOOLS.extend(
    [
        license_compliance.TOOL_DEFINITION,
        cve_lookup.TOOL_DEFINITION,
        documentation.TOOL_DEFINITION,
    ]
)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {"status": "ok", "service": "synesis-mcp"}


@app.get("/health/readiness")
async def readiness():
    return {"status": "ready"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8100)
