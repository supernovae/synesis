"""Unified usage summary (planner_usage_log + optional admin-only trace fallback + Yarn)."""

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
    include_provider_actual: bool,
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
    tokens_in = int(src.get("tokens_in", 0) or 0)
    tokens_cached = int(src.get("tokens_cached", 0) or 0)
    cache_hit_rate = (tokens_cached / tokens_in) if tokens_in > 0 else 0.0

    out = {
        "period_hours": since_hours,
        "trace_count": n,
        "request_count": n,
        "total_tokens": int(src.get("total_tokens", 0)),
        "tokens_in": tokens_in,
        "tokens_cached": tokens_cached,
        "cache_hit_rate": round(cache_hit_rate, 4),
        "price_usd": float(src.get("estimated_cost_usd", 0) or 0),
        "avg_duration_ms": float(src.get("avg_duration_ms", 0) or 0),
        "error_count": int(src.get("error_count", 0)),
        "source": src.get("source", "planner_usage_log"),
        **({"note": note} if note else {}),
    }
    if include_provider_actual:
        out["provider_actual_cost_usd"] = float(src.get("actual_cost_usd", 0) or 0)
    return out


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
    trace_fb = None
    if role >= Role.org_admin:
        trace_fb = await aggregate_traces_period(
            since_hours=since_hours,
            scope_user_id=scope_user_id,
            scope_org_id=scope_org_id,
            scope_tenant_id=scope_tenant_id,
        )
    include_provider_actual = role >= Role.platform_admin
    pipe = _normalize_pipeline_block(
        since_hours=since_hours,
        primary=primary,
        trace_fallback=trace_fb,
        include_provider_actual=include_provider_actual,
    )

    out: dict[str, Any] = {
        "since_hours": since_hours,
        "pipeline": {
            "traces": pipe,
        },
        "glossary": {
            "price": "Configured $/M rates x tokens; pipeline from planner_usage_log when available.",
            "yarn": "IDE/Yarn path (yarn_usage_log), separate from planner-ts pipeline.",
        },
    }
    if include_provider_actual:
        out["glossary"]["provider_actual"] = (
            "Platform-admin-only provider-reported cost when present on LLM calls / metering rows."
        )

    if role >= Role.org_admin:
        try:
            yarn_scope_org_id = scope_org_id if role < Role.platform_admin else ""
            out["yarn"] = await yarn_service.get_yarn_overview(
                since_hours=since_hours,
                scope_user_id="",
                scope_org_id=yarn_scope_org_id,
                include_provider_actual=include_provider_actual,
            )
        except Exception:
            logger.warning("usage_unified_yarn_overview_failed", exc_info=True)
            out["yarn"] = None
    else:
        out["yarn"] = None

    pipeline_price = pipe.get("price_usd", 0) or 0
    pipeline_actual = pipe.get("provider_actual_cost_usd", 0) or 0
    yarn_price = 0.0
    yarn_actual = 0.0
    if out.get("yarn") and isinstance(out["yarn"], dict):
        yarn_price = float(out["yarn"].get("total_price_usd", 0) or 0)
        yarn_actual = float(out["yarn"].get("total_provider_actual_cost_usd", 0) or 0)

    spend = {
        "planner_price_usd": round(pipeline_price, 4),
        "yarn_price_usd": round(yarn_price, 4),
        "total_price_usd": round(pipeline_price + yarn_price, 4),
        "note": "Pipeline = planner_usage_log; Yarn = yarn_usage_log. User/org views use configured usage price. No double-count.",
    }
    if include_provider_actual:
        spend.update(
            {
                "planner_provider_actual_usd": round(pipeline_actual, 4),
                "yarn_provider_actual_usd": round(yarn_actual, 4),
                "total_provider_actual_usd": round(pipeline_actual + yarn_actual, 4),
            }
        )
    out["total_platform_spend"] = spend

    if role >= Role.platform_admin:
        out["debug_yarn_trace_estimated_usd"] = await sum_yarn_trace_estimated_cost(
            since_hours=since_hours,
            scope_user_id=scope_user_id,
            scope_org_id=scope_org_id,
            scope_tenant_id=scope_tenant_id,
        )

    return out
