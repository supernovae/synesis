"""Unified usage summary and reconciliation (pipeline traces, rollups, Yarn)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select

from ..auth import UserInfo
from ..db.engine import async_session
from ..db.models import Trace, YarnUsageLog
from ..rbac import Role, resolve_role, trace_scope_filters
from . import yarn_service
from .trace_store import aggregate_traces_period
from .usage_rollup import get_latest_rollup_bucket, get_usage_summary

logger = logging.getLogger("synesis.admin.usage_unified")


async def get_summary_unified(
    *,
    user: UserInfo,
    since_hours: int = 24,
) -> dict[str, Any]:
    """Pipeline (rollups + raw traces) and optional Yarn totals for org_admin+."""
    scope = trace_scope_filters(user)
    scope_user_id = scope.get("user_id", "") or ""
    scope_org_id = scope.get("org_id", "") or ""
    role = resolve_role(user)

    rollup_summary = await get_usage_summary(
        since_hours=since_hours,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
    )
    trace_totals = await aggregate_traces_period(
        since_hours=since_hours,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
    )
    latest_bucket = await get_latest_rollup_bucket(
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
    )
    now = datetime.now(UTC)
    lag_seconds: int | None = None
    if latest_bucket is not None:
        lag_seconds = max(0, int((now - latest_bucket).total_seconds()))

    out: dict[str, Any] = {
        "since_hours": since_hours,
        "pipeline": {
            "rollups": rollup_summary,
            "traces": trace_totals,
        },
        "rollup_latest_bucket_utc": latest_bucket.isoformat() if latest_bucket else None,
        "rollup_lag_seconds_approx": lag_seconds,
        "glossary": {
            "estimated": "Configured $/M rates x tokens (traces / rollups), not provider invoice.",
            "actual": "Sum of provider-reported per-call costs when present on llm_calls / traces.",
            "rollup": "5-minute buckets from traces; may lag real time until rollup job runs.",
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

    return out


async def get_reconcile(
    *,
    since_hours: int = 24,
) -> dict[str, Any]:
    """Platform-admin: compare rollups vs trace sums vs Yarn (global, unscoped)."""
    cutoff_dt = datetime.now(UTC) - timedelta(hours=since_hours)
    tcut = cutoff_dt.timestamp()

    rollup = await get_usage_summary(
        since_hours=since_hours,
        scope_user_id="",
        scope_org_id="",
    )
    traces = await aggregate_traces_period(
        since_hours=since_hours,
        scope_user_id="",
        scope_org_id="",
    )
    latest_bucket = await get_latest_rollup_bucket(scope_user_id="", scope_org_id="")

    llm_tokens = 0
    llm_estimated = 0.0
    llm_actual = 0.0
    traces_scanned = 0
    partial = False

    async with async_session() as session:
        yarn_row = (
            await session.execute(
                select(
                    func.count().label("n"),
                    func.coalesce(func.sum(YarnUsageLog.tokens_in), 0).label("tin"),
                    func.coalesce(func.sum(YarnUsageLog.tokens_out), 0).label("tout"),
                    func.coalesce(func.sum(YarnUsageLog.tokens_cached), 0).label("tcached"),
                    func.coalesce(func.sum(YarnUsageLog.cost_usd), 0).label("cost"),
                ).where(YarnUsageLog.created_at >= cutoff_dt)
            )
        ).one()

        try:
            trace_rows = (
                (await session.execute(select(Trace).where(Trace.timestamp >= tcut).limit(5000))).scalars().all()
            )
            traces_scanned = len(trace_rows)
            total_in_db = (
                await session.execute(select(func.count()).select_from(Trace).where(Trace.timestamp >= tcut))
            ).scalar() or 0
            partial = total_in_db > traces_scanned

            for tr in trace_rows:
                rec = tr.full_record or {}
                for span in rec.get("spans", []):
                    for call in span.get("llm_calls", []):
                        pt = int(call.get("prompt_tokens", 0))
                        ct = int(call.get("completion_tokens", 0))
                        tot = int(call.get("total_tokens", 0) or 0)
                        llm_tokens += tot if tot else (pt + ct)
                        llm_estimated += float(call.get("estimated_cost", 0) or 0)
                        llm_actual += float(call.get("actual_cost", 0) or 0)
        except Exception:
            logger.warning("usage_reconcile_llm_walk_failed", exc_info=True)

    yarn = {
        "request_count": int(yarn_row.n or 0),
        "tokens_in": int(yarn_row.tin or 0),
        "tokens_out": int(yarn_row.tout or 0),
        "tokens_cached": int(yarn_row.tcached or 0),
        "total_tokens": int((yarn_row.tin or 0) + (yarn_row.tout or 0) + (yarn_row.tcached or 0)),
        "cost_usd": round(float(yarn_row.cost or 0), 4),
    }

    def _pct_diff(a: float, b: float) -> float | None:
        if b == 0:
            return None
        return round(100.0 * (a - b) / b, 2)

    r_tok = rollup.get("total_tokens", 0)
    tr_tok = traces["total_tokens"]
    return {
        "since_hours": since_hours,
        "rollup": rollup,
        "traces_table": traces,
        "yarn": yarn,
        "llm_calls_walk": {
            "prompt_completion_tokens_summed": llm_tokens,
            "estimated_cost_usd": round(llm_estimated, 4),
            "actual_cost_usd": round(llm_actual, 4),
            "traces_scanned": traces_scanned,
            "partial": partial,
            "note": "Walk capped at 5000 most recent traces in window.",
        },
        "deltas": {
            "total_tokens_rollup_minus_trace_row": r_tok - tr_tok,
            "estimated_usd_rollup_minus_trace": rollup.get("estimated_cost_usd", 0) - traces["estimated_cost_usd"],
            "pct_tokens_rollup_vs_trace": _pct_diff(float(r_tok), float(tr_tok)) if tr_tok else None,
        },
        "rollup_latest_bucket_utc": latest_bucket.isoformat() if latest_bucket else None,
    }
