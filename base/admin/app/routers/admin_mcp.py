"""Admin MCP — expose admin JSON API endpoints as MCP tools.

Provides ``/api/v1/mcp/tools`` (list) and ``/api/v1/mcp/tools/call``
(execute) with the same JWT / PAT authentication and RBAC model as the
REST API.  Tool visibility is filtered by the caller's role: platform
admins see all tools, org admins see org-scoped tools, regular users
see only their own data tools.

Each tool call is logged to the ``admin_audit_events`` table.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from ..auth import UserInfo, get_current_user
from ..rbac import Role, resolve_role, trace_scope_filters
from ..services.admin_audit import record_admin_audit

logger = logging.getLogger("synesis.admin.mcp")

router = APIRouter(prefix="/api/v1/mcp", tags=["mcp"])


# ── Tool definitions with minimum role ───────────────────────────────────────

_TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_traces",
        "description": "List recent traces with optional filters. Scoped to the caller's role.",
        "min_role": Role.user,
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "default": 20, "description": "Max results"},
                "has_error": {"type": "boolean", "description": "Filter error traces"},
                "task_type": {"type": "string", "description": "Filter by task type"},
                "since_hours": {"type": "integer", "default": 24, "description": "Lookback hours"},
            },
        },
    },
    {
        "name": "get_trace",
        "description": "Get full detail for a single trace by ID. Scoped to the caller's role.",
        "min_role": Role.user,
        "inputSchema": {
            "type": "object",
            "properties": {
                "trace_id": {"type": "string", "description": "The trace ID to look up"},
            },
            "required": ["trace_id"],
        },
    },
    {
        "name": "trace_stats",
        "description": "Aggregate trace statistics (last 24h). Scoped to the caller's role.",
        "min_role": Role.user,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "usage_summary",
        "description": "Pre-aggregated usage/cost summary. Scoped to the caller's role.",
        "min_role": Role.user,
        "inputSchema": {
            "type": "object",
            "properties": {
                "since_hours": {"type": "integer", "default": 24, "description": "Lookback hours"},
            },
        },
    },
    {
        "name": "service_health",
        "description": "Check health of all Synesis services.",
        "min_role": Role.readonly,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_models",
        "description": "List active model role assignments.",
        "min_role": Role.readonly,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "cache_metrics",
        "description": "Retrieval, prompt, and frame cache hit rates and sizes.",
        "min_role": Role.org_admin,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "circuit_breakers",
        "description": "Current circuit breaker states for LLM, web search, and infra.",
        "min_role": Role.org_admin,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "knowledge_gap_stats",
        "description": "RAG corpus knowledge gap statistics.",
        "min_role": Role.org_admin,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "trigger_usage_rollup",
        "description": "Manually trigger a usage rollup aggregation. Admin only.",
        "min_role": Role.platform_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "lookback_minutes": {"type": "integer", "default": 15},
            },
        },
    },
    {
        "name": "reconcile_litellm",
        "description": "Trigger LiteLLM model reconciliation. Admin only.",
        "min_role": Role.platform_admin,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "purge_trivial_traces",
        "description": "Dry-run count or delete traces below a token threshold. Admin only.",
        "min_role": Role.platform_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "min_tokens": {"type": "integer", "default": 50},
                "dry_run": {"type": "boolean", "default": True},
            },
        },
    },
    {
        "name": "ingestion_list_items",
        "description": "List ingestion queue items with filters. Admin only.",
        "min_role": Role.platform_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "description": "Filter by status (pending, running, indexed, failed, dead_letter)"},
                "handler": {"type": "string", "description": "Filter by handler type"},
                "limit": {"type": "integer", "default": 20, "description": "Max results"},
            },
        },
    },
    {
        "name": "ingestion_patch_item",
        "description": "Edit an ingestion item's metadata or status. Admin only.",
        "min_role": Role.platform_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "item_id": {"type": "integer", "description": "The item ID"},
                "title": {"type": "string"},
                "handler": {"type": "string"},
                "domain": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
                "priority": {"type": "integer"},
                "status": {"type": "string", "description": "Admin-driven status transition"},
                "config": {"type": "object"},
            },
            "required": ["item_id"],
        },
    },
    {
        "name": "ingestion_discover_url",
        "description": "Run discovery on a URL to get a suggested ingestion config. Admin only.",
        "min_role": Role.platform_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to analyse"},
                "hints": {"type": "string", "description": "Optional free-text hints"},
                "use_llm": {"type": "boolean", "default": False, "description": "Use LLM for enrichment"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "ingestion_retry_item",
        "description": "Retry a failed or dead_letter ingestion item. Admin only.",
        "min_role": Role.platform_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "item_id": {"type": "integer", "description": "The item ID"},
                "reset_retries": {"type": "boolean", "default": False, "description": "Reset retry counter"},
            },
            "required": ["item_id"],
        },
    },
    {
        "name": "ingestion_requeue_item",
        "description": "Re-queue any ingestion item back to pending. Admin only.",
        "min_role": Role.platform_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "item_id": {"type": "integer", "description": "The item ID"},
                "reset_retries": {"type": "boolean", "default": False},
            },
            "required": ["item_id"],
        },
    },
]


def _visible_tools(role: Role) -> list[dict[str, Any]]:
    """Return tool definitions the caller is allowed to see."""
    return [
        {k: v for k, v in t.items() if k != "min_role"}
        for t in _TOOLS
        if role >= t["min_role"]
    ]


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/tools")
async def list_tools(user: UserInfo = Depends(get_current_user)):
    """MCP tools/list — returns tools visible to the caller's role."""
    role = resolve_role(user)
    return {"tools": _visible_tools(role)}


@router.post("/tools/call")
async def call_tool(
    body: dict = Body(...),
    user: UserInfo = Depends(get_current_user),
):
    """MCP tools/call — execute a tool by name with RBAC + audit logging."""
    tool_name = body.get("name", "")
    arguments = body.get("arguments", {})
    role = resolve_role(user)

    tool_def = next((t for t in _TOOLS if t["name"] == tool_name), None)
    if tool_def is None:
        raise HTTPException(status_code=404, detail=f"Unknown tool: {tool_name}")

    if role < tool_def["min_role"]:
        raise HTTPException(
            status_code=403,
            detail=f"Tool '{tool_name}' requires {tool_def['min_role'].name} role",
        )

    handler = _HANDLERS.get(tool_name)
    if handler is None:
        raise HTTPException(status_code=501, detail=f"Tool '{tool_name}' not implemented")

    try:
        result = await handler(user, arguments)

        await record_admin_audit(
            action=f"mcp.tool.{tool_name}",
            status="success",
            summary=f"MCP tool call: {tool_name}",
            detail={"arguments": arguments},
            user=user,
            source="mcp",
        )

        if isinstance(result, str):
            return {"content": [{"type": "text", "text": result}]}
        return {"content": [{"type": "text", "text": json.dumps(result, default=str)}]}

    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("mcp_tool_%s_failed", tool_name, exc_info=True)
        await record_admin_audit(
            action=f"mcp.tool.{tool_name}",
            status="error",
            summary=f"MCP tool call failed: {tool_name} — {type(exc).__name__}",
            detail={"arguments": arguments, "error": str(exc)[:500]},
            user=user,
            source="mcp",
        )
        raise HTTPException(status_code=500, detail=f"Tool '{tool_name}' failed") from exc


# ── Tool handlers ────────────────────────────────────────────────────────────

import time


async def _list_traces(user: UserInfo, args: dict) -> Any:
    from ..services import trace_store

    scope = trace_scope_filters(user)
    since = 0.0
    if args.get("since_hours"):
        since = time.time() - (args["since_hours"] * 3600)
    return await trace_store.list_traces(
        limit=min(args.get("limit", 20), 100),
        has_error=args.get("has_error"),
        task_type=args.get("task_type", ""),
        since=since,
        scope_user_id=scope.get("user_id", ""),
        scope_org_id=scope.get("org_id", ""),
    )


async def _get_trace(user: UserInfo, args: dict) -> Any:
    from ..rbac import can_access_trace
    from ..services import trace_store

    trace_id = args.get("trace_id", "")
    if not trace_id:
        raise HTTPException(status_code=400, detail="trace_id required")
    record = await trace_store.get_trace(trace_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    if not can_access_trace(user, record):
        raise HTTPException(status_code=403, detail="Not authorized to view this trace")
    return record


async def _trace_stats(user: UserInfo, args: dict) -> Any:
    from ..services import trace_store

    scope = trace_scope_filters(user)
    return await trace_store.get_trace_stats(
        scope_user_id=scope.get("user_id", ""),
        scope_org_id=scope.get("org_id", ""),
    )


async def _usage_summary(user: UserInfo, args: dict) -> Any:
    from ..services.usage_rollup import get_usage_summary

    scope = trace_scope_filters(user)
    return await get_usage_summary(
        since_hours=args.get("since_hours", 24),
        scope_user_id=scope.get("user_id", ""),
        scope_org_id=scope.get("org_id", ""),
    )


async def _service_health(user: UserInfo, args: dict) -> Any:
    from ..services.health_prober import probe_all

    return {"services": await probe_all()}


async def _list_models(user: UserInfo, args: dict) -> Any:
    from ..services.model_registry import get_role_assignments

    return {"roles": await get_role_assignments()}


async def _cache_metrics(user: UserInfo, args: dict) -> Any:
    from ..services import prometheus_client_svc as prom

    return await prom.get_extended_cache_metrics()


async def _circuit_breakers(user: UserInfo, args: dict) -> Any:
    from ..services import prometheus_client_svc as prom

    return {"breakers": await prom.get_circuit_breaker_metrics()}


async def _knowledge_gap_stats(user: UserInfo, args: dict) -> Any:
    from sqlalchemy import func, select

    from ..db.engine import async_session
    from ..db.models import KnowledgeGap

    async with async_session() as session:
        total = (await session.execute(select(func.count()).select_from(KnowledgeGap))).scalar() or 0
        open_count = (
            await session.execute(
                select(func.count())
                .select_from(KnowledgeGap)
                .where(KnowledgeGap.status.in_(["open", "reopened"]))
            )
        ).scalar() or 0
    return {"total_gaps": total, "open": open_count, "resolved": total - open_count}


async def _trigger_usage_rollup(user: UserInfo, args: dict) -> Any:
    from ..services.usage_rollup import run_rollup

    return await run_rollup(lookback_minutes=args.get("lookback_minutes", 15))


async def _reconcile_litellm(user: UserInfo, args: dict) -> Any:
    from ..services.model_reconciler import reconcile

    return await reconcile()


async def _purge_trivial_traces(user: UserInfo, args: dict) -> Any:
    from sqlalchemy import text as sa_text

    from ..db.engine import async_session as db_session

    min_tokens = args.get("min_tokens", 50)
    dry_run = args.get("dry_run", True)

    async with db_session() as session:
        count_row = (
            await session.execute(
                sa_text("SELECT COUNT(*)::int AS cnt FROM traces WHERE total_tokens < :min"),
                {"min": min_tokens},
            )
        ).one()
        count = count_row.cnt

        if dry_run or count == 0:
            return {"would_delete": count, "dry_run": True, "min_tokens": min_tokens}

        await session.execute(sa_text("DELETE FROM traces WHERE total_tokens < :min"), {"min": min_tokens})
        await session.commit()
    return {"deleted": count, "dry_run": False, "min_tokens": min_tokens}


async def _ingestion_list_items(user: UserInfo, args: dict) -> Any:
    from .ingestion import list_items as _list_items_impl

    class _FakeUser:
        username = user.username
        sub = user.sub
        roles = user.roles
        org_id = getattr(user, "org_id", "")

    return await _list_items_impl(
        _user=_FakeUser(),  # type: ignore[arg-type]
        status=args.get("status", ""),
        handler=args.get("handler", ""),
        domain="",
        source_id=None,
        page=1,
        page_size=min(args.get("limit", 20), 100),
    )


async def _ingestion_patch_item(user: UserInfo, args: dict) -> Any:
    from .ingestion import ItemPatch, patch_item

    item_id = args.get("item_id")
    if not item_id:
        raise HTTPException(status_code=400, detail="item_id required")
    body = ItemPatch(**{k: v for k, v in args.items() if k != "item_id"})
    return await patch_item(item_id, body, user)


async def _ingestion_discover_url(user: UserInfo, args: dict) -> Any:
    from .ingestion import DiscoverRequest, discover_url

    url = args.get("url", "")
    if not url:
        raise HTTPException(status_code=400, detail="url required")
    req = DiscoverRequest(
        url=url,
        hints=args.get("hints", ""),
        use_llm=args.get("use_llm", False),
    )
    return await discover_url(req, user)


async def _ingestion_retry_item(user: UserInfo, args: dict) -> Any:
    from .ingestion import retry_item

    item_id = args.get("item_id")
    if not item_id:
        raise HTTPException(status_code=400, detail="item_id required")
    return await retry_item(item_id, reset_retries=args.get("reset_retries", False), _user=user)


async def _ingestion_requeue_item(user: UserInfo, args: dict) -> Any:
    from .ingestion import requeue_item

    item_id = args.get("item_id")
    if not item_id:
        raise HTTPException(status_code=400, detail="item_id required")
    return await requeue_item(item_id, reset_retries=args.get("reset_retries", False), _user=user)


_HANDLERS: dict[str, Any] = {
    "list_traces": _list_traces,
    "get_trace": _get_trace,
    "trace_stats": _trace_stats,
    "usage_summary": _usage_summary,
    "service_health": _service_health,
    "list_models": _list_models,
    "cache_metrics": _cache_metrics,
    "circuit_breakers": _circuit_breakers,
    "knowledge_gap_stats": _knowledge_gap_stats,
    "trigger_usage_rollup": _trigger_usage_rollup,
    "reconcile_litellm": _reconcile_litellm,
    "purge_trivial_traces": _purge_trivial_traces,
    "ingestion_list_items": _ingestion_list_items,
    "ingestion_patch_item": _ingestion_patch_item,
    "ingestion_discover_url": _ingestion_discover_url,
    "ingestion_retry_item": _ingestion_retry_item,
    "ingestion_requeue_item": _ingestion_requeue_item,
}
