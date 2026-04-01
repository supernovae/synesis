"""Unified usage summary (planner_usage_log + Yarn; traces optional fallback)."""

from __future__ import annotations

import logging
from typing import Any

from ..auth import UserInfo
from ..rbac import Role, resolve_role, trace_scope_filters
from . import yarn_service
from .planner_usage_service import aggregate_planner_usage_period
from .trace_store import aggregate_traces_period, sum_yarn_trace_estimated_cost

logger = logging.getLogger("synesis.admin.usage_unified")


def _normalize_pipeline_block(
    *,
    since_hours: int,
    primary: dict[str, Any],
    trace_fallback: dict[str, Any] | None,
) -> dict[str, Any]:
    """Single shape for Models overview: prefer planner_usage_log, else traces."""
    if (primary.get("request_count") or 0) > 0:
        src = primary
        note = None
    elif trace_fallback and (trace_fallback.get("trace_count") or 0) > 0:
        src = trace_fallback
        note = "Trace aggregates (pipeline-only rows) until planner_usage_log is populated by planner-ts."
    else:
        src = primary
        note = None

    n = int(src.get("request_count") or src.get("trace_count") or 0)
    return {
        "period_hours": since_hours,
        "trace_count": n,
        "request_count": n,
        "total_tokens": int(src.get("total_tokens", 0)),
        "estimated_cost_usd": float(src.get("estimated_cost_usd", 0) or 0),
        "actual_cost_usd": float(src.get("actual_cost_usd", 0) or 0),
        "avg_duration_ms": float(src.get("avg_duration_ms", 0) or 0),
        "error_count": int(src.get("error_count", 0)),
        "source": src.get("source", "planner_usage_log"),
        **({"note": note} if note else {}),
    }


async def get_summary_unified(
    *,
    user: UserInfo,
    since_hours: int = 24,
) -> dict[str, Any]:
    """Pipeline metering (planner_usage_log) and optional Yarn totals."""
    scope = trace_scope_filters(user)
    scope_user_id = scope.get("user_id", "") or ""
    scope_org_id = scope.get("org_id", "") or ""
    scope_tenant_id = scope.get("scope_tenant_id", "") or ""
    role = resolve_role(user)

    primary = await aggregate_planner_usage_period(
        since_hours=since_hours,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
        scope_tenant_id=scope_tenant_id,
    )
    trace_fb = await aggregate_traces_period(
        since_hours=since_hours,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
        scope_tenant_id=scope_tenant_id,
    )
    pipe = _normalize_pipeline_block(since_hours=since_hours, primary=primary, trace_fallback=trace_fb)

    out: dict[str, Any] = {
        "since_hours": since_hours,
        "pipeline": {
            "traces": pipe,
        },
        "glossary": {
            "estimated": "Configured $/M rates x tokens; pipeline from planner_usage_log when available.",
            "actual": "Sum of provider-reported costs when present on LLM calls / metering rows.",
            "yarn": "IDE/Yarn path (yarn_usage_log), separate from LangGraph pipeline.",
        },
    }

    if role >= Role.org_admin:
        try:
            yarn_scope_org_id = scope_org_id if role < Role.platform_admin else ""
            out["yarn"] = await yarn_service.get_yarn_overview(
                since_hours=since_hours,
                scope_user_id="",
                scope_org_id=yarn_scope_org_id,
            )
        except Exception:
            logger.warning("usage_unified_yarn_overview_failed", exc_info=True)
            out["yarn"] = None
    else:
        out["yarn"] = None

    pipeline_est = pipe.get("estimated_cost_usd", 0) or 0
    pipeline_act = pipe.get("actual_cost_usd", 0) or 0
    yarn_cost = 0.0
    if out.get("yarn") and isinstance(out["yarn"], dict):
        yarn_cost = float(out["yarn"].get("total_cost_usd", 0) or 0)

    out["total_platform_spend"] = {
        "planner_estimated_usd": round(pipeline_est, 4),
        "planner_actual_usd": round(pipeline_act, 4),
        "yarn_estimated_usd": round(yarn_cost, 4),
        "yarn_actual_usd": 0,
        "total_estimated_usd": round(pipeline_est + yarn_cost, 4),
        "total_actual_usd": round(pipeline_act, 4),
        "effective_total_usd": round(max(pipeline_act, pipeline_est) + yarn_cost, 4),
        "note": "Pipeline = planner_usage_log (or trace fallback); Yarn = yarn_usage_log. No double-count.",
    }

    if role >= Role.platform_admin:
        out["debug_yarn_trace_estimated_usd"] = await sum_yarn_trace_estimated_cost(
            since_hours=since_hours,
            scope_user_id=scope_user_id,
            scope_org_id=scope_org_id,
            scope_tenant_id=scope_tenant_id,
        )

    return out
