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

import os
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from synesis_telemetry import configure_logging, get_logger

configure_logging(service="synesis-mcp")
logger = get_logger("synesis.mcp")

PLANNER_URL = os.environ.get(
    "SYNESIS_PLANNER_URL",
    "http://synesis-planner.synesis-planner.svc.cluster.local:8000",
)
CRITIC_URL = os.environ.get(
    "SYNESIS_CRITIC_URL",
    "http://synesis-critic.synesis-models.svc.cluster.local:8080/v1",
)
CRITIC_MODEL = os.environ.get("SYNESIS_CRITIC_MODEL", "synesis-critic")

app = FastAPI(title="Synesis MCP Server", version="0.1.0")


# ---------------------------------------------------------------------------
# MCP Tool Registry
# ---------------------------------------------------------------------------
from .tools import cve_lookup, documentation, license_compliance, patch_integrity

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
            "ranked chunks with provenance and relevance scores. Supports "
            "label-scoped filtering by language, artifact kind, domain, "
            "repository, tags, and content format for targeted corpus queries."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "top_k": {"type": "integer", "description": "Number of results", "default": 5},
                "language": {
                    "type": "string",
                    "description": "Filter by programming language (e.g. python, go, rust, typescript)",
                },
                "artifact_kind": {
                    "type": "string",
                    "description": "Filter by artifact type: code, docs, config, or api_spec",
                    "enum": ["code", "docs", "config", "api_spec"],
                },
                "domain": {
                    "type": "string",
                    "description": "Filter by taxonomy domain (e.g. python, kubernetes, cloud)",
                },
                "repo_path": {
                    "type": "string",
                    "description": "Filter by repository path (e.g. tiangolo/fastapi)",
                },
                "tags": {
                    "type": "string",
                    "description": "Filter by tag substring match (e.g. async, web, ml)",
                },
                "content_format": {
                    "type": "string",
                    "description": "Filter by content format (e.g. python, yaml, json, hcl)",
                },
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
            content={"error": f"Tool '{tool_name}' failed. Check server logs for details."},
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
                "model": "Synesis",
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
                "model": "Synesis",
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
    """RAG retrieval against Synesis catalog with optional label-scoped filters."""
    payload: dict[str, Any] = {"query": args["query"]}
    for key in ("top_k", "language", "artifact_kind", "domain", "repo_path", "tags", "content_format"):
        val = args.get(key)
        if val is not None and val != "":
            payload[key] = val

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{PLANNER_URL}/v1/knowledge/search",
            json=payload,
        )
        if resp.status_code == 404:
            return {"results": [], "note": "Knowledge search endpoint not yet available"}
        resp.raise_for_status()
        return resp.json()


async def _code_search(args: dict[str, Any]) -> dict[str, Any]:
    """Search only code artifacts, optionally scoped by language."""
    merged = {**args, "artifact_kind": "code"}
    return await _search(merged)


async def _docs_search(args: dict[str, Any]) -> dict[str, Any]:
    """Search only documentation artifacts, optionally scoped by domain."""
    merged = {**args, "artifact_kind": "docs"}
    return await _search(merged)


async def _config_search(args: dict[str, Any]) -> dict[str, Any]:
    """Search only configuration artifacts, optionally scoped by language."""
    merged = {**args, "artifact_kind": "config"}
    return await _search(merged)


_TOOL_HANDLERS = {
    "synesis_classify": _classify,
    "synesis_plan": _plan,
    "synesis_critique": _critique,
    "synesis_search": _search,
    "synesis_code_search": _code_search,
    "synesis_docs_search": _docs_search,
    "synesis_config_search": _config_search,
    "synesis_license_check": license_compliance.handle,
    "synesis_cve_check": cve_lookup.handle,
    "synesis_docs_lookup": documentation.handle,
    "synesis_patch_integrity": patch_integrity.handle,
}

# Convenience scoped-search tools — thin wrappers over synesis_search
# with preset artifact_kind for clear tool semantics.
TOOLS.extend(
    [
        {
            "name": "synesis_code_search",
            "description": (
                "Search the Synesis code corpus. Returns ranked code chunks "
                "(functions, classes, modules) with provenance. Use this to "
                "find code examples, patterns, and implementations. Filters "
                "to artifact_kind=code automatically; optionally narrow by "
                "language (python, go, rust, etc.) or repository."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What code to search for"},
                    "top_k": {"type": "integer", "description": "Number of results", "default": 5},
                    "language": {
                        "type": "string",
                        "description": "Programming language filter (e.g. python, go, rust)",
                    },
                    "domain": {"type": "string", "description": "Taxonomy domain filter (e.g. python, kubernetes)"},
                    "repo_path": {"type": "string", "description": "Repository filter (e.g. owner/repo)"},
                    "tags": {"type": "string", "description": "Tag substring filter (e.g. async, web)"},
                },
                "required": ["query"],
            },
        },
        {
            "name": "synesis_docs_search",
            "description": (
                "Search the Synesis documentation corpus. Returns ranked "
                "documentation chunks (guides, READMEs, articles, papers) "
                "with provenance. Filters to artifact_kind=docs automatically; "
                "optionally narrow by domain or tags."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What documentation to search for"},
                    "top_k": {"type": "integer", "description": "Number of results", "default": 5},
                    "domain": {"type": "string", "description": "Taxonomy domain filter (e.g. kubernetes, cloud)"},
                    "tags": {"type": "string", "description": "Tag substring filter"},
                },
                "required": ["query"],
            },
        },
        {
            "name": "synesis_config_search",
            "description": (
                "Search the Synesis configuration corpus. Returns ranked "
                "config chunks (YAML, JSON, HCL, TOML files — Kubernetes "
                "manifests, Terraform modules, CI pipelines, etc.) with "
                "provenance. Filters to artifact_kind=config automatically; "
                "optionally narrow by content format or language."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What configuration to search for"},
                    "top_k": {"type": "integer", "description": "Number of results", "default": 5},
                    "language": {"type": "string", "description": "Language/format filter (e.g. yaml, hcl, json)"},
                    "content_format": {
                        "type": "string",
                        "description": "Content format filter (e.g. yaml, json, hcl, toml)",
                    },
                    "domain": {"type": "string", "description": "Taxonomy domain filter"},
                    "tags": {"type": "string", "description": "Tag substring filter"},
                },
                "required": ["query"],
            },
        },
    ]
)

# Register additional tool definitions
TOOLS.extend(
    [
        license_compliance.TOOL_DEFINITION,
        cve_lookup.TOOL_DEFINITION,
        documentation.TOOL_DEFINITION,
        patch_integrity.TOOL_DEFINITION,
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

    uvicorn.run(app, host="0.0.0.0", port=8100)  # nosec B104
