"""Legacy Python Admin MCP compatibility + support-assistant tool execution.

``synesis-admin-mcp-ts`` is now the source of truth for admin MCP catalog + invocation.
This module remains for:

- support-assistant tool execution via ``invoke_mcp_tool_for_chat``
- compatibility endpoints under ``/api/v1/internal/mcp`` for older callers

Transition-calibration MCP tooling is TS-owned and intentionally excluded from this
legacy Python catalog to prevent split-brain tool drift.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from ..auth import UserInfo, get_current_user
from ..rbac import Role, RouteGroup, can_access_route_group, resolve_role, trace_scope_filters
from ..services.admin_audit import record_admin_audit

logger = logging.getLogger("synesis.admin.mcp")

internal_router = APIRouter(prefix="/api/v1/internal/mcp", tags=["mcp-internal"])


# ── Tool definitions with minimum role ───────────────────────────────────────

_TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_traces",
        "description": (
            "List recent traces with optional filters (same data as GET /api/v1/traces). "
            "Supports trace_service (yarn|planner|all), conversation_id, decision_path, tenant_id, offset."
        ),
        "min_role": Role.org_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "default": 20, "description": "Max results (max 100)"},
                "offset": {"type": "integer", "default": 0, "description": "Pagination offset"},
                "has_error": {"type": "boolean", "description": "Filter error traces"},
                "task_type": {"type": "string", "description": "Filter by task type"},
                "since_hours": {"type": "integer", "description": "If set, only traces newer than this many hours ago"},
                "trace_service": {
                    "type": "string",
                    "description": "Filter by emitter: planner, yarn, or all (default all)",
                },
                "conversation_id": {"type": "string", "description": "Filter by conversation / session id"},
                "decision_path": {
                    "type": "string",
                    "description": "Filter by routing path (deterministic, constrained, inference_first, abstain)",
                },
                "tenant_id": {"type": "string", "description": "Optional tenant filter (scoped callers)"},
                "user_id": {"type": "string", "description": "Optional user id filter (within RBAC scope)"},
                "org_id": {"type": "string", "description": "Optional org id filter (within RBAC scope)"},
            },
        },
    },
    {
        "name": "get_trace",
        "description": "Get full detail for a single trace by ID. Scoped to the caller's role.",
        "min_role": Role.org_admin,
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
        "description": "Aggregate trace statistics (last 24h), same as GET /api/v1/traces/stats.",
        "min_role": Role.org_admin,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "trace_decision_analytics",
        "description": (
            "Decision-path and verification analytics from trace JSONB (GET /api/v1/traces/analytics). "
            "Requires org observability access."
        ),
        "min_role": Role.org_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "since_hours": {
                    "type": "integer",
                    "default": 24,
                    "description": "Start of window (hours ago); maps to since/until on the API",
                },
                "org_id": {
                    "type": "string",
                    "description": "Optional org filter (platform admin); else caller org scope",
                },
            },
        },
    },
    {
        "name": "usage_summary",
        "description": (
            "Pre-aggregated usage/cost summary from trace aggregates (legacy shape). "
            "For full pipeline + Yarn + glossary, prefer unified_usage_snapshot."
        ),
        "min_role": Role.org_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "since_hours": {"type": "integer", "default": 24, "description": "Lookback hours"},
            },
        },
    },
    {
        "name": "usage_time_series",
        "description": (
            "Hourly usage buckets (planner_usage_log; trace fallback) — same as GET /api/v1/usage. "
            "Requires org observability. Use for token/cost trends over time."
        ),
        "min_role": Role.org_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "since_hours": {"type": "integer", "default": 24, "description": "Lookback hours (1-720)"},
            },
        },
    },
    {
        "name": "unified_usage_snapshot",
        "description": (
            "Full usage and cost snapshot: pipeline trace totals, "
            "glossary of cost fields, and Yarn IDE usage for org_admin+. "
            "Prefer this when the user asks about costs, spend, or unified usage."
        ),
        "min_role": Role.user,
        "inputSchema": {
            "type": "object",
            "properties": {
                "since_hours": {"type": "integer", "default": 24, "description": "Lookback hours"},
            },
        },
    },
    {
        "name": "yarn_overview",
        "description": "Yarn ops overview: sessions, tokens, costs (GET /api/v1/yarn/overview).",
        "min_role": Role.org_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "since_hours": {"type": "integer", "default": 24, "description": "Lookback hours"},
            },
        },
    },
    {
        "name": "yarn_intelligence",
        "description": "Yarn intelligence rollup for the period (GET /api/v1/yarn/intelligence).",
        "min_role": Role.org_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "since_hours": {"type": "integer", "default": 24, "description": "Lookback hours"},
            },
        },
    },
    {
        "name": "yarn_sessions",
        "description": "List Yarn IDE sessions (GET /api/v1/yarn/sessions).",
        "min_role": Role.org_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "page": {"type": "integer", "default": 1},
                "page_size": {"type": "integer", "default": 20, "description": "Max 100"},
                "active_since_hours": {
                    "type": "integer",
                    "default": 168,
                    "description": "Only sessions active in this window",
                },
            },
        },
    },
    {
        "name": "yarn_session_detail",
        "description": "Full detail for one Yarn session by session_key (GET /api/v1/yarn/sessions/{key}).",
        "min_role": Role.org_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_key": {"type": "string", "description": "Yarn session key"},
            },
            "required": ["session_key"],
        },
    },
    {
        "name": "yarn_performance",
        "description": "Yarn latency and throughput buckets (GET /api/v1/yarn/performance).",
        "min_role": Role.org_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "since_hours": {"type": "integer", "default": 24},
                "bucket_minutes": {"type": "integer", "default": 15, "description": "Bucket size 5-60"},
            },
        },
    },
    {
        "name": "yarn_events",
        "description": "Yarn session events and errors (GET /api/v1/yarn/events).",
        "min_role": Role.org_admin,
        "inputSchema": {
            "type": "object",
            "properties": {
                "page": {"type": "integer", "default": 1},
                "page_size": {"type": "integer", "default": 50},
                "since_hours": {"type": "integer", "default": 24},
                "errors_only": {"type": "boolean", "default": False},
            },
        },
    },
    {
        "name": "yarn_safety_summary",
        "description": "Yarn safety / policy events summary (GET /api/v1/yarn/safety-summary).",
        "min_role": Role.org_admin,
        "inputSchema": {
            "type": "object",
            "properties": {"since_hours": {"type": "integer", "default": 24}},
        },
    },
    # NOTE: Transition-quality MCP tooling moved to synesis-admin-mcp-ts.
    # Keep Python MCP focused on support-compatible surfaces.
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
        "description": "Prefix cache hit rates, token savings, and session stats for planner-ts and yarn-ts.",
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
        "name": "refresh_model_routes",
        "description": "Report the direct model route source of truth. Admin only.",
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
                "status": {
                    "type": "string",
                    "description": "Filter by status (pending, running, indexed, failed, dead_letter)",
                },
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
    # ── Developer value-add tools (Yarn/Coder agents) ────────────────────
    {
        "name": "synesis_search",
        "description": (
            "Search the Synesis knowledge corpus (RAG). Returns relevant evidence "
            "packets for coding, architecture, or operational questions."
        ),
        "min_role": Role.user,
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural language search query"},
                "top_k": {"type": "integer", "default": 5, "description": "Max results"},
                "domain": {"type": "string", "description": "Optional domain filter"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "synesis_classify_intent",
        "description": (
            "Classify a developer query into Synesis taxonomy categories "
            "(task type, complexity, domain). Useful for routing and steering."
        ),
        "min_role": Role.user,
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The developer query to classify"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "synesis_retrieval_gaps",
        "description": (
            "Report a retrieval gap — a question the corpus could not answer. "
            "Feeds the curator pipeline for knowledge improvement."
        ),
        "min_role": Role.user,
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The question that had no good answer"},
                "context": {"type": "string", "description": "What was the user trying to do"},
            },
            "required": ["query"],
        },
    },
]


def _visible_tools(role: Role) -> list[dict[str, Any]]:
    """Return tool definitions the caller is allowed to see."""
    return [{k: v for k, v in t.items() if k != "min_role"} for t in _TOOLS if role >= t["min_role"]]


def catalog_all_tools() -> list[dict[str, Any]]:
    """Full Admin MCP tool catalog with minimum role (for Integrations UI / operators)."""
    return [
        {
            "name": t["name"],
            "description": t.get("description", ""),
            "min_role": t["min_role"].name,
        }
        for t in _TOOLS
    ]


def visible_tools_for_role(role: Role) -> list[dict[str, Any]]:
    """Public alias for Integrations UI (role-filtered tool list)."""
    return _visible_tools(role)


def openai_function_tools_for_role(
    role: Role,
    *,
    allowed_tool_names: set[str] | None = None,
) -> list[dict[str, Any]]:
    """OpenAI-compatible ``tools`` entries (function calling) for the given role.

    ``allowed_tool_names`` can be used to enforce a stricter profile (e.g. support
    assistant) while still honoring role-based minimums.
    """
    out: list[dict[str, Any]] = []
    for t in _TOOLS:
        if role < t["min_role"]:
            continue
        if allowed_tool_names is not None and t["name"] not in allowed_tool_names:
            continue
        schema = t.get("inputSchema") or {"type": "object", "properties": {}}
        out.append(
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": schema,
                },
            }
        )
    return out


def _coerce_arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return {}
        try:
            return json.loads(s)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid JSON in arguments: {exc}") from exc
    if raw is None:
        return {}
    raise HTTPException(status_code=400, detail="arguments must be an object or JSON string")


def _http_exception_detail(exc: HTTPException) -> str:
    d = exc.detail
    if isinstance(d, str):
        return d
    try:
        return json.dumps(d)
    except TypeError:
        return str(d)


def _resolve_tool(user: UserInfo, tool_name: str) -> tuple[dict[str, Any], Any]:
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
    return tool_def, handler


async def invoke_mcp_tool_for_chat(
    user: UserInfo,
    tool_name: str,
    arguments: dict[str, Any],
    *,
    audit_source: str = "assistant",
) -> str:
    """Execute an MCP tool and return text for a chat ``tool`` message.

    Unlike the HTTP ``/mcp/tools/call`` endpoint, this never raises for RBAC or
    handler errors — failures are JSON-encoded so the LLM can recover.
    """
    try:
        _, handler = _resolve_tool(user, tool_name)
    except HTTPException as e:
        return json.dumps({"error": _http_exception_detail(e), "tool": tool_name})

    try:
        result = await handler(user, arguments)
        await record_admin_audit(
            action=f"mcp.tool.{tool_name}",
            status="success",
            summary=f"MCP tool call: {tool_name}",
            detail={"arguments": arguments},
            user=user,
            source=audit_source,
        )
        if isinstance(result, str):
            return result
        return json.dumps(result, default=str)
    except HTTPException as e:
        await record_admin_audit(
            action=f"mcp.tool.{tool_name}",
            status="error",
            summary=f"MCP tool call failed: {tool_name} — {_http_exception_detail(e)}",
            detail={"arguments": arguments, "error": _http_exception_detail(e)},
            user=user,
            source=audit_source,
        )
        return json.dumps({"error": _http_exception_detail(e), "tool": tool_name})
    except Exception as exc:
        logger.warning("mcp_tool_%s_failed", tool_name, exc_info=True)
        await record_admin_audit(
            action=f"mcp.tool.{tool_name}",
            status="error",
            summary=f"MCP tool call failed: {tool_name} — {type(exc).__name__}",
            detail={"arguments": arguments, "error": str(exc)[:500]},
            user=user,
            source=audit_source,
        )
        return json.dumps({"error": str(exc), "tool": tool_name})


# ── Tool handlers ────────────────────────────────────────────────────────────


def _ensure_org_observability(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_observability):
        raise HTTPException(status_code=403, detail="Requires route group access: org_observability")


def _ensure_org_admin(user: UserInfo) -> None:
    if resolve_role(user) < Role.org_admin:
        raise HTTPException(status_code=403, detail="Requires org_admin role or higher")


def _yarn_scope(user: UserInfo) -> tuple[str, str, str]:
    """Match ``yarn`` router: (scope_user_id, scope_org_id, scope_tenant_id)."""
    role = resolve_role(user)
    if role >= Role.platform_admin:
        return "", "", ""
    if role >= Role.org_admin:
        return "", user.org_id or "", ""
    tenant_ids = getattr(user, "tenant_ids", None) or []
    scope_tenant = (tenant_ids[0].strip()[:64]) if tenant_ids else ""
    return user.user_id or user.username, "", scope_tenant


_TRANSITION_EVENT_KINDS = {
    "request_trajectory_v1",
    "state_transition_v1",
    "state_transition_quality_calibration_v1",
    "state_transition_quality_global_calibration_v1",
}
_TRANSITION_RISK_LABELS = {"regressed", "reground_required"}


def _coerce_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _coerce_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        text = str(item or "").strip()
        if text:
            out.append(text)
    return out


def _extract_transition_event_view(event_kind: str, metadata_json: Any) -> dict[str, Any]:
    metadata = metadata_json if isinstance(metadata_json, dict) else {}
    training = metadata.get("training_signals")
    quality = metadata.get("quality")

    training_dict = training if isinstance(training, dict) else {}
    quality_dict = quality if isinstance(quality, dict) else {}

    label = str(training_dict.get("state_transition_quality_label") or "").strip().lower()
    if not label:
        label = str(quality_dict.get("label") or "").strip().lower()

    score = _coerce_float(training_dict.get("state_transition_quality_score"))
    if score is None:
        score = _coerce_float(quality_dict.get("score"))

    global_scope = str(training_dict.get("state_transition_quality_global_scope") or "").strip() or None
    reasons = _str_list(training_dict.get("state_transition_quality_reasons"))
    if not reasons:
        reasons = _str_list(quality_dict.get("reasons"))

    risk_flags = _str_list(training_dict.get("state_transition_quality_risk_flags"))
    if score is not None and score < 0 and "negative_quality_score" not in risk_flags:
        risk_flags.append("negative_quality_score")
    if label in _TRANSITION_RISK_LABELS:
        flag = f"quality_label_{label}"
        if flag not in risk_flags:
            risk_flags.append(flag)
    if event_kind == "state_transition_quality_global_calibration_v1":
        if "global_calibration" not in risk_flags:
            risk_flags.append("global_calibration")
    if event_kind == "state_transition_quality_calibration_v1":
        if "local_calibration" not in risk_flags:
            risk_flags.append("local_calibration")

    calibration_samples = _coerce_int(training_dict.get("state_transition_quality_calibration_sample_count"), 0)
    if calibration_samples <= 0 and event_kind.endswith("calibration_v1"):
        calibration_meta = metadata.get("calibration")
        if isinstance(calibration_meta, dict):
            calibration_samples = _coerce_int(calibration_meta.get("sample_count"), 0)

    return {
        "quality_label": label or None,
        "quality_score": score,
        "global_scope": global_scope,
        "reasons": reasons,
        "risk_flags": risk_flags,
        "calibration_sample_count": calibration_samples if calibration_samples > 0 else None,
    }


async def _list_traces(user: UserInfo, args: dict) -> Any:
    from ..services import trace_store

    scope = trace_scope_filters(user)
    since = 0.0
    if args.get("since_hours") is not None:
        since = time.time() - (int(args["since_hours"]) * 3600)
    effective_tenant = (str(args.get("tenant_id", "")).strip()) or scope.get("scope_tenant_id", "")
    return await trace_store.list_traces(
        offset=max(0, int(args.get("offset", 0))),
        limit=min(int(args.get("limit", 20)), 100),
        has_error=args.get("has_error"),
        task_type=str(args.get("task_type", "") or ""),
        conversation_id=str(args.get("conversation_id", "") or "").strip(),
        decision_path=str(args.get("decision_path", "") or "").strip(),
        trace_service=str(args.get("trace_service", "") or "").strip(),
        user_id=str(args.get("user_id", "") or "").strip(),
        org_id=str(args.get("org_id", "") or "").strip(),
        since=since,
        scope_user_id=scope.get("user_id", ""),
        scope_org_id=scope.get("org_id", ""),
        scope_tenant_id=effective_tenant,
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
        scope_tenant_id=scope.get("scope_tenant_id", ""),
    )


async def _trace_decision_analytics(user: UserInfo, args: dict) -> Any:
    from ..services import trace_store

    _ensure_org_observability(user)
    scope = trace_scope_filters(user)
    since_hours = int(args.get("since_hours", 24))
    since_ts = time.time() - since_hours * 3600
    effective_org = str(args.get("org_id", "") or "").strip() or scope.get("org_id", "")
    return await trace_store.get_decision_analytics(
        since=since_ts,
        until=0,
        scope_org_id=effective_org,
        scope_tenant_id=scope.get("scope_tenant_id", ""),
    )


async def _usage_summary(user: UserInfo, args: dict) -> Any:
    from ..services.trace_store import aggregate_traces_period

    scope = trace_scope_filters(user)
    return await aggregate_traces_period(
        since_hours=int(args.get("since_hours", 24)),
        scope_user_id=scope.get("user_id", ""),
        scope_org_id=scope.get("org_id", ""),
        scope_tenant_id=scope.get("scope_tenant_id", ""),
    )


async def _usage_time_series(user: UserInfo, args: dict) -> Any:
    from ..services.planner_usage_service import planner_usage_time_series
    from ..services.trace_store import trace_time_series

    _ensure_org_observability(user)
    since_hours = int(args.get("since_hours", 24))
    since_hours = max(1, min(since_hours, 720))
    scope = trace_scope_filters(user)
    su = scope.get("user_id", "") or ""
    so = scope.get("org_id", "") or ""
    st = scope.get("scope_tenant_id", "") or ""
    pl_series = await planner_usage_time_series(
        since_hours=since_hours,
        scope_user_id=su,
        scope_org_id=so,
        scope_tenant_id=st,
    )
    if pl_series and sum(b.get("requests", 0) for b in pl_series) > 0:
        return pl_series
    return await trace_time_series(
        since_hours=since_hours,
        scope_user_id=su,
        scope_org_id=so,
        scope_tenant_id=st,
    )


async def _unified_usage_snapshot(user: UserInfo, args: dict) -> Any:
    from ..services.usage_unified import get_summary_unified

    return await get_summary_unified(user=user, since_hours=int(args.get("since_hours", 24)))


async def _yarn_overview(user: UserInfo, args: dict) -> Any:
    from ..services import yarn_service

    _ensure_org_admin(user)
    su, so, _ = _yarn_scope(user)
    return await yarn_service.get_yarn_overview(
        since_hours=int(args.get("since_hours", 24)),
        scope_user_id=su,
        scope_org_id=so,
    )


async def _yarn_intelligence(user: UserInfo, args: dict) -> Any:
    from ..services import yarn_service

    _ensure_org_admin(user)
    su, so, _ = _yarn_scope(user)
    return await yarn_service.get_yarn_intelligence(
        since_hours=int(args.get("since_hours", 24)),
        scope_user_id=su,
        scope_org_id=so,
    )


async def _yarn_sessions(user: UserInfo, args: dict) -> Any:
    from ..services import yarn_service

    _ensure_org_admin(user)
    su, so, _ = _yarn_scope(user)
    ash = args.get("active_since_hours", 168)
    return await yarn_service.list_yarn_sessions(
        page=int(args.get("page", 1)),
        page_size=min(int(args.get("page_size", 20)), 100),
        scope_user_id=su,
        scope_org_id=so,
        active_since_hours=int(ash) if ash is not None else 168,
    )


async def _yarn_session_detail(user: UserInfo, args: dict) -> Any:
    from ..services import yarn_service

    _ensure_org_admin(user)
    key = str(args.get("session_key", "") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="session_key required")
    su, so, _ = _yarn_scope(user)
    detail = await yarn_service.get_yarn_session_detail(
        key,
        scope_user_id=su,
        scope_org_id=so,
    )
    if not detail:
        raise HTTPException(status_code=404, detail="Session not found")
    return detail


async def _yarn_performance(user: UserInfo, args: dict) -> Any:
    from ..services import yarn_service

    _ensure_org_admin(user)
    su, so, _ = _yarn_scope(user)
    bm = int(args.get("bucket_minutes", 15))
    bm = max(5, min(bm, 60))
    return await yarn_service.get_yarn_performance(
        since_hours=int(args.get("since_hours", 24)),
        bucket_minutes=bm,
        scope_user_id=su,
        scope_org_id=so,
    )


async def _yarn_events(user: UserInfo, args: dict) -> Any:
    from ..services import yarn_service

    _ensure_org_admin(user)
    su, so, _ = _yarn_scope(user)
    return await yarn_service.list_yarn_events(
        page=int(args.get("page", 1)),
        page_size=min(int(args.get("page_size", 50)), 200),
        scope_user_id=su,
        scope_org_id=so,
        since_hours=int(args.get("since_hours", 24)),
        errors_only=bool(args.get("errors_only", False)),
    )


async def _yarn_safety_summary(user: UserInfo, args: dict) -> Any:
    from ..services import yarn_service

    _ensure_org_admin(user)
    su, so, _ = _yarn_scope(user)
    return await yarn_service.get_yarn_safety_summary(
        since_hours=int(args.get("since_hours", 24)),
        scope_user_id=su,
        scope_org_id=so,
    )


async def _yarn_transition_quality(user: UserInfo, args: dict) -> Any:
    from ..services import yarn_service

    _ensure_org_admin(user)
    su, so, _ = _yarn_scope(user)
    since_hours = max(1, min(_coerce_int(args.get("since_hours", 168), 168), 720))
    bucket_minutes = max(5, min(_coerce_int(args.get("bucket_minutes", 60), 60), 60))
    return await yarn_service.get_yarn_transition_quality_series(
        since_hours=since_hours,
        bucket_minutes=bucket_minutes,
        scope_user_id=su,
        scope_org_id=so,
    )


async def _yarn_transition_events_tail(user: UserInfo, args: dict) -> Any:
    from sqlalchemy import select

    from ..db.engine import async_session
    from ..db.models import YarnSessionEvent

    _ensure_org_admin(user)
    su, so, _ = _yarn_scope(user)
    since_minutes = max(1, min(_coerce_int(args.get("since_minutes", 60), 60), 1440))
    limit = max(1, min(_coerce_int(args.get("limit", 100), 100), 500))
    after_id = max(0, _coerce_int(args.get("after_id", 0), 0))
    risk_only = bool(args.get("risk_only", True))
    include_metadata = bool(args.get("include_metadata", False))
    kinds_arg = args.get("event_kinds")
    requested_kinds = _str_list(kinds_arg) if isinstance(kinds_arg, list) else []
    event_kinds = requested_kinds or sorted(_TRANSITION_EVENT_KINDS)
    cutoff = datetime.now(UTC) - timedelta(minutes=since_minutes)

    async with async_session() as session:
        stmt = select(YarnSessionEvent).where(YarnSessionEvent.created_at >= cutoff)
        if su:
            stmt = stmt.where(YarnSessionEvent.user_id == su)
        elif so:
            stmt = stmt.where(YarnSessionEvent.org_id == so)
        if after_id > 0:
            stmt = stmt.where(YarnSessionEvent.id > after_id)
        if event_kinds:
            stmt = stmt.where(YarnSessionEvent.event_kind.in_(event_kinds))
        rows = (await session.execute(stmt.order_by(YarnSessionEvent.id.desc()).limit(limit))).scalars().all()

    rows = list(reversed(rows))
    events: list[dict[str, Any]] = []
    counts_by_kind: dict[str, int] = {}
    next_after_id = after_id
    sessions: set[str] = set()
    requests: set[str] = set()

    for row in rows:
        event_view = _extract_transition_event_view(row.event_kind, row.metadata_json)
        risk_flags = list(event_view["risk_flags"])
        is_risk = bool(risk_flags)
        if risk_only and not is_risk:
            continue

        sessions.add(row.session_key)
        if row.request_id:
            requests.add(row.request_id)
        counts_by_kind[row.event_kind] = counts_by_kind.get(row.event_kind, 0) + 1
        next_after_id = max(next_after_id, int(row.id))

        item: dict[str, Any] = {
            "id": int(row.id),
            "session_key": row.session_key,
            "request_id": row.request_id,
            "event_kind": row.event_kind,
            "component": row.component,
            "detail": row.detail,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "quality_label": event_view["quality_label"],
            "quality_score": event_view["quality_score"],
            "global_scope": event_view["global_scope"],
            "reasons": event_view["reasons"],
            "risk_flags": risk_flags,
            "calibration_sample_count": event_view["calibration_sample_count"],
        }
        if include_metadata:
            item["metadata_json"] = row.metadata_json
        events.append(item)

    return {
        "since_minutes": since_minutes,
        "event_kinds": event_kinds,
        "risk_only": risk_only,
        "include_metadata": include_metadata,
        "count": len(events),
        "session_count": len(sessions),
        "request_count": len(requests),
        "counts_by_kind": counts_by_kind,
        "next_after_id": next_after_id,
        "events": events,
    }


async def _yarn_transition_watch(user: UserInfo, args: dict) -> Any:
    polls = max(1, min(_coerce_int(args.get("polls", 4), 4), 12))
    interval_seconds = float(args.get("interval_seconds", 5) or 5)
    interval_seconds = max(1.0, min(interval_seconds, 30.0))
    since_hours = max(1, min(_coerce_int(args.get("since_hours", 24), 24), 720))
    bucket_minutes = max(5, min(_coerce_int(args.get("bucket_minutes", 15), 15), 60))
    events_since_minutes = max(1, min(_coerce_int(args.get("events_since_minutes", 30), 30), 1440))
    event_limit = max(1, min(_coerce_int(args.get("event_limit", 120), 120), 300))
    risk_only = bool(args.get("risk_only", True))
    include_metadata = bool(args.get("include_metadata", False))
    cursor = max(0, _coerce_int(args.get("after_id", 0), 0))

    frames: list[dict[str, Any]] = []
    collected_events: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    quality_snapshot: dict[str, Any] = {}
    watch_started_at = datetime.now(UTC).isoformat()

    for idx in range(polls):
        quality_snapshot = await _yarn_transition_quality(
            user,
            {"since_hours": since_hours, "bucket_minutes": bucket_minutes},
        )
        tail = await _yarn_transition_events_tail(
            user,
            {
                "since_minutes": events_since_minutes,
                "limit": event_limit,
                "after_id": cursor,
                "risk_only": risk_only,
                "include_metadata": include_metadata,
            },
        )
        cursor = max(cursor, _coerce_int(tail.get("next_after_id", cursor), cursor))

        new_events: list[dict[str, Any]] = []
        for event in tail.get("events", []):
            event_id = _coerce_int(event.get("id"), 0)
            if event_id <= 0 or event_id in seen_ids:
                continue
            seen_ids.add(event_id)
            new_events.append(event)
            collected_events.append(event)

        summary = quality_snapshot.get("summary", {}) if isinstance(quality_snapshot, dict) else {}
        frames.append(
            {
                "iteration": idx + 1,
                "captured_at": datetime.now(UTC).isoformat(),
                "quality_score_avg": summary.get("quality_score_avg"),
                "regressed_rate_avg": summary.get("regressed_rate_avg"),
                "reground_required_rate_avg": summary.get("reground_required_rate_avg"),
                "global_scope_coverage_avg": summary.get("global_scope_coverage_avg"),
                "risk_flags": summary.get("risk_flags") or [],
                "new_event_count": len(new_events),
                "next_after_id": cursor,
                "new_events": new_events,
            }
        )
        if idx < polls - 1:
            await asyncio.sleep(interval_seconds)

    summary = quality_snapshot.get("summary", {}) if isinstance(quality_snapshot, dict) else {}
    actions = quality_snapshot.get("actions", []) if isinstance(quality_snapshot, dict) else []
    return {
        "watch": {
            "started_at": watch_started_at,
            "ended_at": datetime.now(UTC).isoformat(),
            "polls": polls,
            "interval_seconds": interval_seconds,
            "since_hours": since_hours,
            "bucket_minutes": bucket_minutes,
            "events_since_minutes": events_since_minutes,
            "event_limit": event_limit,
            "risk_only": risk_only,
            "next_after_id": cursor,
        },
        "final_quality_summary": summary,
        "recommended_actions": actions,
        "frames": frames,
        "events": collected_events[-200:],
    }


async def _yarn_transition_incident_brief(user: UserInfo, args: dict) -> Any:
    since_hours = max(1, min(_coerce_int(args.get("since_hours", 24), 24), 720))
    bucket_minutes = max(5, min(_coerce_int(args.get("bucket_minutes", 15), 15), 60))
    events_since_minutes = max(1, min(_coerce_int(args.get("events_since_minutes", 180), 180), 1440))
    event_limit = max(1, min(_coerce_int(args.get("event_limit", 150), 150), 300))

    quality = await _yarn_transition_quality(
        user,
        {
            "since_hours": since_hours,
            "bucket_minutes": bucket_minutes,
        },
    )
    tail = await _yarn_transition_events_tail(
        user,
        {
            "since_minutes": events_since_minutes,
            "limit": event_limit,
            "risk_only": True,
            "include_metadata": False,
        },
    )

    summary = quality.get("summary", {}) if isinstance(quality, dict) else {}
    top_reasons = quality.get("top_quality_reasons", []) if isinstance(quality, dict) else []
    risk_flags = summary.get("risk_flags", []) if isinstance(summary, dict) else []
    actions = quality.get("actions", []) if isinstance(quality, dict) else []
    recent_events = tail.get("events", []) if isinstance(tail, dict) else []
    latest_event = recent_events[-1] if recent_events else None

    priority_findings: list[str] = []
    if "high_regressed_rate" in risk_flags:
        priority_findings.append("Regressed transition rate is above warning threshold.")
    if "high_reground_required_rate" in risk_flags:
        priority_findings.append("Re-ground required rate is elevated; file-state confidence may be degrading.")
    if "low_global_scope_coverage" in risk_flags:
        priority_findings.append("Global scope coverage is low; check calibrator scope key stability.")
    if "missing_global_calibration_events" in risk_flags:
        priority_findings.append("No global calibration events observed in the active analysis window.")
    if not priority_findings:
        priority_findings.append("No major window-level transition quality alerts are active.")

    return {
        "window": {
            "since_hours": since_hours,
            "bucket_minutes": bucket_minutes,
            "events_since_minutes": events_since_minutes,
            "event_limit": event_limit,
        },
        "quality_summary": summary,
        "risk_flags": risk_flags,
        "priority_findings": priority_findings,
        "top_quality_reasons": top_reasons[:6],
        "recommended_actions": actions[:6],
        "event_tail": {
            "count": tail.get("count", 0),
            "session_count": tail.get("session_count", 0),
            "request_count": tail.get("request_count", 0),
            "counts_by_kind": tail.get("counts_by_kind", {}),
            "latest_event": latest_event,
            "events": recent_events[-20:],
        },
        "next_best_questions": [
            "Which sessions dominate regressed transitions and what quality reasons repeat?",
            "Are global calibration events lagging behind local calibration in this period?",
            "Do risk spikes correlate with specific models or finish reasons?",
        ],
    }


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
                select(func.count()).select_from(KnowledgeGap).where(KnowledgeGap.status.in_(["open", "reopened"]))
            )
        ).scalar() or 0
    return {"total_gaps": total, "open": open_count, "resolved": total - open_count}


async def _refresh_model_routes(user: UserInfo, args: dict) -> Any:
    return {"source_of_truth": "admin_db", "runtime": "direct_provider_routes", "route_refresh_required": False}


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


async def _synesis_search(user: UserInfo, args: dict) -> Any:
    """Search the Synesis RAG corpus via the planner's search endpoint."""
    query = args.get("query", "")
    if not query:
        raise HTTPException(status_code=400, detail="query required")

    import httpx

    from ..config import get_settings

    cfg = get_settings()
    planner_url = cfg.planner_url or "http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{planner_url}/v1/search",
                json={
                    "query": query,
                    "top_k": args.get("top_k", 5),
                    "domain": args.get("domain", ""),
                },
                headers={"Authorization": f"Bearer {cfg.internal_service_token}"},
            )
            if resp.status_code == 200:
                return resp.json()
            return {"results": [], "note": f"Planner search returned {resp.status_code}"}
    except Exception as exc:
        return {"results": [], "error": str(exc)}


async def _synesis_classify_intent(user: UserInfo, args: dict) -> Any:
    """Classify a developer query using lightweight heuristics."""
    query = (args.get("query") or "").lower().strip()
    if not query:
        raise HTTPException(status_code=400, detail="query required")

    categories: list[str] = []
    if any(w in query for w in ("debug", "error", "fix", "crash", "traceback", "exception")):
        categories.append("debugging")
    if any(w in query for w in ("deploy", "kubernetes", "openshift", "helm", "container")):
        categories.append("operations")
    if any(w in query for w in ("test", "pytest", "coverage", "assert")):
        categories.append("testing")
    if any(w in query for w in ("refactor", "rename", "extract", "clean")):
        categories.append("refactoring")
    if any(w in query for w in ("api", "endpoint", "route", "rest", "graphql")):
        categories.append("api_design")
    if any(w in query for w in ("security", "auth", "rbac", "token", "jwt")):
        categories.append("security")
    if not categories:
        categories.append("general_coding")

    complexity = "simple"
    if len(query.split()) > 20:
        complexity = "moderate"
    if len(query.split()) > 50 or any(w in query for w in ("architecture", "design", "system")):
        complexity = "complex"

    return {"categories": categories, "complexity": complexity, "query_length": len(query)}


async def _synesis_retrieval_gaps(user: UserInfo, args: dict) -> Any:
    """Record a retrieval gap for the curator pipeline."""
    query = args.get("query", "")
    if not query:
        raise HTTPException(status_code=400, detail="query required")

    from sqlalchemy import text as sa_text

    from ..db.engine import async_session as db_session

    context = args.get("context", "")
    async with db_session() as session:
        await session.execute(
            sa_text(
                """
                INSERT INTO knowledge_gaps (query, context_snippet, status, source, reported_by)
                VALUES (:query, :context, 'open', 'mcp_tool', :user_id)
                """
            ),
            {"query": query[:2000], "context": context[:2000], "user_id": getattr(user, "sub", "")},
        )
        await session.commit()
    return {"recorded": True, "query": query[:200]}


_HANDLERS: dict[str, Any] = {
    "list_traces": _list_traces,
    "get_trace": _get_trace,
    "trace_stats": _trace_stats,
    "trace_decision_analytics": _trace_decision_analytics,
    "usage_summary": _usage_summary,
    "usage_time_series": _usage_time_series,
    "unified_usage_snapshot": _unified_usage_snapshot,
    "yarn_overview": _yarn_overview,
    "yarn_intelligence": _yarn_intelligence,
    "yarn_sessions": _yarn_sessions,
    "yarn_session_detail": _yarn_session_detail,
    "yarn_performance": _yarn_performance,
    "yarn_events": _yarn_events,
    "yarn_safety_summary": _yarn_safety_summary,
    "service_health": _service_health,
    "list_models": _list_models,
    "cache_metrics": _cache_metrics,
    "circuit_breakers": _circuit_breakers,
    "knowledge_gap_stats": _knowledge_gap_stats,
    "refresh_model_routes": _refresh_model_routes,
    "purge_trivial_traces": _purge_trivial_traces,
    "ingestion_list_items": _ingestion_list_items,
    "ingestion_patch_item": _ingestion_patch_item,
    "ingestion_discover_url": _ingestion_discover_url,
    "ingestion_retry_item": _ingestion_retry_item,
    "ingestion_requeue_item": _ingestion_requeue_item,
    "synesis_search": _synesis_search,
    "synesis_classify_intent": _synesis_classify_intent,
    "synesis_retrieval_gaps": _synesis_retrieval_gaps,
}


@internal_router.get("/tools")
async def internal_list_tools(user: UserInfo = Depends(get_current_user)):
    """Tools visible to the caller (used by synesis-admin-mcp-ts to build MCP tools/list)."""
    role = resolve_role(user)
    return {"tools": _visible_tools(role)}


@internal_router.post("/invoke")
async def internal_invoke(body: dict = Body(...), user: UserInfo = Depends(get_current_user)):
    """Execute one admin MCP tool (used by synesis-admin-mcp-ts)."""
    tool_name = body.get("name", "")
    try:
        arguments = _coerce_arguments(body.get("arguments", {}))
    except HTTPException:
        raise

    _, handler = _resolve_tool(user, tool_name)

    try:
        result = await handler(user, arguments)
        await record_admin_audit(
            action=f"mcp.tool.{tool_name}",
            status="success",
            summary=f"MCP tool call: {tool_name}",
            detail={"arguments": arguments},
            user=user,
            source="admin-mcp-ts",
        )
        return {"result": result}
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
            source="admin-mcp-ts",
        )
        raise HTTPException(status_code=500, detail=f"Tool '{tool_name}' failed") from exc
