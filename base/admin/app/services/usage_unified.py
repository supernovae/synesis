"""Unified usage summary (pipeline traces + Yarn)."""

from __future__ import annotations

import logging
from typing import Any

from ..auth import UserInfo
from ..rbac import Role, resolve_role, trace_scope_filters
from . import yarn_service
from .trace_store import aggregate_traces_period

logger = logging.getLogger("synesis.admin.usage_unified")


async def get_summary_unified(
    *,
    user: UserInfo,
    since_hours: int = 24,
) -> dict[str, Any]:
    """Pipeline traces and optional Yarn totals for org_admin+."""
    scope = trace_scope_filters(user)
    scope_user_id = scope.get("user_id", "") or ""
    scope_org_id = scope.get("org_id", "") or ""
    role = resolve_role(user)

    traces = await aggregate_traces_period(
        since_hours=since_hours,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
    )

    out: dict[str, Any] = {
        "since_hours": since_hours,
        "pipeline": {
            "traces": traces,
        },
        "glossary": {
            "estimated": "Configured $/M rates x tokens from traces, not provider invoice.",
            "actual": "Sum of provider-reported per-call costs when present on llm_calls / traces.",
            "yarn": "IDE/Yarn path (yarn_usage_log), separate from LangGraph pipeline traces.",
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

    pipeline_est = traces.get("estimated_cost_usd", 0) or 0
    pipeline_act = traces.get("actual_cost_usd", 0) or 0
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
        "effective_total_usd": round(
            max(pipeline_act, pipeline_est) + yarn_cost, 4
        ),
        "note": "effective = max(actual, estimated) per service; never $0 when tokens consumed.",
    }

    return out
