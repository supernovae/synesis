"""Planner pipeline metering from planner_usage_log (decoupled from traces)."""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import sqlalchemy as sa
from sqlalchemy import case, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..db.engine import async_session
from ..db.models import PlannerUsageLog

logger = logging.getLogger("synesis.admin.planner_usage")


async def upsert_metering_row(record: dict[str, Any]) -> None:
    """Insert or update one metering row (idempotent on request_id)."""
    rid = (record.get("request_id") or record.get("trace_id") or "").strip()[:64]
    if not rid:
        logger.warning("planner_usage_metering_skip_no_request_id")
        return

    values = {
        "request_id": rid,
        "user_id": (record.get("user_id") or "")[:256],
        "org_id": (record.get("org_id") or "")[:256],
        "tenant_id": (record.get("tenant_id") or "")[:64],
        "conversation_id": (record.get("conversation_id") or "")[:128],
        "model": (record.get("model") or "")[:256],
        "tokens_in": int(record.get("tokens_in", 0) or 0),
        "tokens_out": int(record.get("tokens_out", 0) or 0),
        "tokens_cached": int(record.get("tokens_cached", 0) or 0),
        "estimated_cost_usd": float(record.get("estimated_cost_usd", 0) or 0),
        "actual_cost_usd": float(record.get("actual_cost_usd", 0) or 0),
        "pricing_source": (record.get("pricing_source") or "unknown")[:32],
        "latency_ms": float(record.get("latency_ms", 0) or 0),
        "has_error": bool(record.get("has_error", False)),
    }

    async with async_session() as session:
        try:
            ins = pg_insert(PlannerUsageLog).values(**values)
            stmt = ins.on_conflict_do_update(
                index_elements=["request_id"],
                set_={
                    "user_id": ins.excluded.user_id,
                    "org_id": ins.excluded.org_id,
                    "tenant_id": ins.excluded.tenant_id,
                    "conversation_id": ins.excluded.conversation_id,
                    "model": ins.excluded.model,
                    "tokens_in": ins.excluded.tokens_in,
                    "tokens_out": ins.excluded.tokens_out,
                    "tokens_cached": ins.excluded.tokens_cached,
                    "estimated_cost_usd": ins.excluded.estimated_cost_usd,
                    "actual_cost_usd": ins.excluded.actual_cost_usd,
                    "pricing_source": ins.excluded.pricing_source,
                    "latency_ms": ins.excluded.latency_ms,
                    "has_error": ins.excluded.has_error,
                },
            )
            await session.execute(stmt)
            await session.commit()
        except Exception:
            logger.warning("planner_usage_upsert_failed", exc_info=True)
            await session.rollback()


async def aggregate_planner_usage_period(
    *,
    since_hours: int = 24,
    scope_user_id: str = "",
    scope_org_id: str = "",
    scope_tenant_id: str = "",
) -> dict[str, Any]:
    """Sum planner_usage_log over a window (RBAC-scoped)."""
    cutoff = time.time() - since_hours * 3600
    cutoff_aware = datetime.fromtimestamp(cutoff, tz=UTC)

    async with async_session() as session:
        try:
            q = select(
                func.count().label("n"),
                func.coalesce(
                    func.sum(PlannerUsageLog.tokens_in + PlannerUsageLog.tokens_out + PlannerUsageLog.tokens_cached),
                    0,
                ).label("total_tokens"),
                func.coalesce(func.sum(PlannerUsageLog.estimated_cost_usd), 0).label("estimated_cost_usd"),
                func.coalesce(func.sum(PlannerUsageLog.actual_cost_usd), 0).label("actual_cost_usd"),
                func.coalesce(func.avg(PlannerUsageLog.latency_ms), 0).label("avg_duration_ms"),
                func.sum(case((PlannerUsageLog.has_error == True, 1), else_=0)).label("error_count"),
            ).where(PlannerUsageLog.created_at >= cutoff_aware)

            if scope_user_id:
                q = q.where(PlannerUsageLog.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(PlannerUsageLog.org_id == scope_org_id)

            if scope_tenant_id:
                q = q.where(PlannerUsageLog.tenant_id == scope_tenant_id)

            row = (await session.execute(q)).one()
            n_req = int(row.n or 0)
            return {
                "period_hours": since_hours,
                "trace_count": n_req,
                "request_count": n_req,
                "total_tokens": int(row.total_tokens or 0),
                "estimated_cost_usd": round(float(row.estimated_cost_usd or 0), 4),
                "actual_cost_usd": round(float(row.actual_cost_usd or 0), 4),
                "avg_duration_ms": round(float(row.avg_duration_ms or 0), 1),
                "error_count": int(row.error_count or 0),
                "source": "planner_usage_log",
            }
        except Exception:
            logger.warning("planner_usage_aggregate_failed", exc_info=True)
            return {
                "period_hours": since_hours,
                "request_count": 0,
                "trace_count": 0,
                "total_tokens": 0,
                "estimated_cost_usd": 0.0,
                "actual_cost_usd": 0.0,
                "avg_duration_ms": 0.0,
                "error_count": 0,
                "source": "planner_usage_log",
            }


async def aggregate_planner_usage_24h_for_dashboard(
    *,
    scope_user_id: str = "",
    scope_org_id: str = "",
    scope_tenant_id: str = "",
) -> dict[str, Any]:
    """24h rollup for dashboard card: request count, estimated spend, avg cost."""
    cutoff_aware = datetime.now(tz=UTC) - timedelta(hours=24)

    async with async_session() as session:
        try:
            q = select(
                func.count().label("n"),
                func.coalesce(func.sum(PlannerUsageLog.estimated_cost_usd), 0).label("total_est"),
                func.coalesce(func.avg(PlannerUsageLog.estimated_cost_usd), 0).label("avg_est"),
            ).where(PlannerUsageLog.created_at >= cutoff_aware)

            if scope_user_id:
                q = q.where(PlannerUsageLog.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(PlannerUsageLog.org_id == scope_org_id)

            if scope_tenant_id:
                q = q.where(PlannerUsageLog.tenant_id == scope_tenant_id)

            row = (await session.execute(q)).one()
            n = int(row.n or 0)
            total_est = float(row.total_est or 0)
            avg_est = float(row.avg_est or 0) if n else 0.0
            return {
                "request_count_24h": n,
                "estimated_spend_24h_usd": round(total_est, 4),
                "avg_estimated_cost_usd": round(avg_est, 6),
                "source": "planner_usage_log",
            }
        except Exception:
            logger.warning("planner_usage_dashboard_aggregate_failed", exc_info=True)
            return {
                "request_count_24h": 0,
                "estimated_spend_24h_usd": 0.0,
                "avg_estimated_cost_usd": 0.0,
                "source": "planner_usage_log",
            }


async def planner_usage_time_series(
    *,
    since_hours: int = 24,
    scope_user_id: str = "",
    scope_org_id: str = "",
    scope_tenant_id: str = "",
) -> list[dict[str, Any]]:
    """Hourly buckets from planner_usage_log (for account Usage chart)."""
    cutoff = time.time() - since_hours * 3600
    cutoff_aware = datetime.fromtimestamp(cutoff, tz=UTC)

    async with async_session() as session:
        try:
            bucket_col = func.date_trunc(sa.literal_column("'hour'"), PlannerUsageLog.created_at).label("bucket")
            q = (
                select(
                    bucket_col,
                    func.count().label("requests"),
                    func.coalesce(
                        func.sum(
                            PlannerUsageLog.tokens_in + PlannerUsageLog.tokens_out + PlannerUsageLog.tokens_cached
                        ),
                        0,
                    ).label("total_tokens"),
                    func.coalesce(func.sum(PlannerUsageLog.estimated_cost_usd), 0).label("estimated_cost_usd"),
                    func.coalesce(func.sum(PlannerUsageLog.actual_cost_usd), 0).label("actual_cost_usd"),
                    func.coalesce(func.avg(PlannerUsageLog.latency_ms), 0).label("avg_duration_ms"),
                    func.sum(case((PlannerUsageLog.has_error == True, 1), else_=0)).label("error_count"),
                )
                .where(PlannerUsageLog.created_at >= cutoff_aware)
                .group_by(bucket_col)
                .order_by(bucket_col.desc())
            )
            if scope_user_id:
                q = q.where(PlannerUsageLog.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(PlannerUsageLog.org_id == scope_org_id)
            if scope_tenant_id:
                q = q.where(PlannerUsageLog.tenant_id == scope_tenant_id)

            rows = (await session.execute(q)).all()
            return [
                {
                    "bucket": r.bucket.isoformat() if r.bucket else "",
                    "requests": int(r.requests or 0),
                    "total_tokens": int(r.total_tokens or 0),
                    "estimated_cost_usd": round(float(r.estimated_cost_usd or 0), 6),
                    "actual_cost_usd": round(float(r.actual_cost_usd or 0), 6),
                    "avg_duration_ms": round(float(r.avg_duration_ms or 0), 1),
                    "error_count": int(r.error_count or 0),
                }
                for r in rows
            ]
        except Exception:
            logger.warning("planner_usage_time_series_failed", exc_info=True)
            return []
