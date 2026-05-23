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
from .token_cost import estimate_llm_cost_breakdown

logger = logging.getLogger("synesis.admin.planner_usage")


def _float_field(data: dict[str, Any], key: str, default: float = 0.0) -> float:
    try:
        return float(data.get(key, default) or default)
    except (TypeError, ValueError):
        return default


def _int_field(data: dict[str, Any], key: str, default: int = 0) -> int:
    try:
        return int(data.get(key, default) or default)
    except (TypeError, ValueError):
        return default


def _cache_breakdown(record: dict[str, Any]) -> dict[str, float | int]:
    prompt = _int_field(record, "tokens_in")
    cached = _int_field(record, "tokens_cached")
    cache_write = _int_field(record, "tokens_cache_write")
    output = _int_field(record, "tokens_out")
    rates = record.get("rates_snapshot") if isinstance(record.get("rates_snapshot"), dict) else {}
    if rates:
        cached_rate_raw = rates.get("cached_input_per_million")
        if cached_rate_raw is None:
            cached_rate_raw = rates.get("input_cached_per_million")
        cache_write_rate_raw = rates.get("cache_write_input_per_million")
        if cache_write_rate_raw is None:
            cache_write_rate_raw = rates.get("input_cache_write_per_million")
        return estimate_llm_cost_breakdown(
            prompt,
            output,
            cached,
            cache_write,
            input_per_million=_float_field(rates, "input_per_million"),
            output_per_million=_float_field(rates, "output_per_million"),
            input_cached_per_million=_float_field({"v": cached_rate_raw}, "v") if cached_rate_raw is not None else None,
            input_cache_write_per_million=(
                _float_field({"v": cache_write_rate_raw}, "v") if cache_write_rate_raw is not None else None
            ),
        )
    estimated = _float_field(record, "estimated_cost_usd")
    return {
        "tokens_uncached_input": max(0, prompt - cached),
        "tokens_cache_read": cached,
        "tokens_cache_write": cache_write,
        "tokens_output": output,
        "input_cost_usd": _float_field(record, "input_cost_usd"),
        "cache_read_cost_usd": _float_field(record, "cache_read_cost_usd"),
        "cache_write_cost_usd": _float_field(record, "cache_write_cost_usd"),
        "output_cost_usd": _float_field(record, "output_cost_usd"),
        "estimated_cost_usd": estimated,
        "estimated_no_cache_cost_usd": _float_field(record, "estimated_no_cache_cost_usd", estimated),
        "cache_savings_usd": _float_field(record, "cache_savings_usd"),
    }


async def upsert_metering_row(record: dict[str, Any]) -> None:
    """Insert or update one metering row (idempotent on request_id)."""
    rid = (record.get("request_id") or record.get("trace_id") or "").strip()[:64]
    if not rid:
        logger.warning("planner_usage_metering_skip_no_request_id")
        return

    breakdown = _cache_breakdown(record)
    values = {
        "request_id": rid,
        "user_id": (record.get("user_id") or "")[:256],
        "org_id": (record.get("org_id") or "")[:256],
        "tenant_id": (record.get("tenant_id") or "")[:64],
        "conversation_id": (record.get("conversation_id") or "")[:128],
        "model": (record.get("model") or "")[:256],
        "tokens_in": _int_field(record, "tokens_in"),
        "tokens_out": _int_field(record, "tokens_out"),
        "tokens_cached": _int_field(record, "tokens_cached"),
        "tokens_uncached_input": int(breakdown["tokens_uncached_input"]),
        "tokens_cache_read": int(breakdown["tokens_cache_read"]),
        "tokens_cache_write": int(breakdown["tokens_cache_write"]),
        "input_cost_usd": float(breakdown["input_cost_usd"]),
        "cache_read_cost_usd": float(breakdown["cache_read_cost_usd"]),
        "cache_write_cost_usd": float(breakdown["cache_write_cost_usd"]),
        "output_cost_usd": float(breakdown["output_cost_usd"]),
        "estimated_no_cache_cost_usd": float(breakdown["estimated_no_cache_cost_usd"]),
        "cache_savings_usd": float(breakdown["cache_savings_usd"]),
        "estimated_cost_usd": float(record.get("estimated_cost_usd", 0) or 0),
        "actual_cost_usd": float(record.get("actual_cost_usd", 0) or 0),
        "pricing_source": (record.get("pricing_source") or "unknown")[:32],
        "auth_method": (record.get("auth_method") or "")[:32],
        "auth_key_id": (record.get("auth_key_id") or "")[:128],
        "auth_key_name": (record.get("auth_key_name") or "")[:256],
        "auth_key_prefix": (record.get("auth_key_prefix") or "")[:32],
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
                    "tokens_uncached_input": ins.excluded.tokens_uncached_input,
                    "tokens_cache_read": ins.excluded.tokens_cache_read,
                    "tokens_cache_write": ins.excluded.tokens_cache_write,
                    "input_cost_usd": ins.excluded.input_cost_usd,
                    "cache_read_cost_usd": ins.excluded.cache_read_cost_usd,
                    "cache_write_cost_usd": ins.excluded.cache_write_cost_usd,
                    "output_cost_usd": ins.excluded.output_cost_usd,
                    "estimated_no_cache_cost_usd": ins.excluded.estimated_no_cache_cost_usd,
                    "cache_savings_usd": ins.excluded.cache_savings_usd,
                    "estimated_cost_usd": ins.excluded.estimated_cost_usd,
                    "actual_cost_usd": ins.excluded.actual_cost_usd,
                    "pricing_source": ins.excluded.pricing_source,
                    "auth_method": ins.excluded.auth_method,
                    "auth_key_id": ins.excluded.auth_key_id,
                    "auth_key_name": ins.excluded.auth_key_name,
                    "auth_key_prefix": ins.excluded.auth_key_prefix,
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
                func.coalesce(func.sum(PlannerUsageLog.tokens_in), 0).label("tokens_in"),
                func.coalesce(func.sum(PlannerUsageLog.tokens_cached), 0).label("tokens_cached"),
                func.coalesce(func.sum(PlannerUsageLog.tokens_cache_write), 0).label("tokens_cache_write"),
                func.coalesce(func.sum(PlannerUsageLog.estimated_no_cache_cost_usd), 0).label(
                    "estimated_no_cache_cost_usd"
                ),
                func.coalesce(func.sum(PlannerUsageLog.cache_savings_usd), 0).label("cache_savings_usd"),
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
                "tokens_in": int(row.tokens_in or 0),
                "tokens_cached": int(row.tokens_cached or 0),
                "tokens_cache_write": int(row.tokens_cache_write or 0),
                "estimated_no_cache_cost_usd": round(float(row.estimated_no_cache_cost_usd or 0), 4),
                "cache_savings_usd": round(float(row.cache_savings_usd or 0), 4),
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
                "tokens_in": 0,
                "tokens_cached": 0,
                "tokens_cache_write": 0,
                "estimated_no_cache_cost_usd": 0.0,
                "cache_savings_usd": 0.0,
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
                    func.coalesce(func.sum(PlannerUsageLog.estimated_no_cache_cost_usd), 0).label(
                        "estimated_no_cache_cost_usd"
                    ),
                    func.coalesce(func.sum(PlannerUsageLog.cache_savings_usd), 0).label("cache_savings_usd"),
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
                    "estimated_no_cache_cost_usd": round(float(r.estimated_no_cache_cost_usd or 0), 6),
                    "cache_savings_usd": round(float(r.cache_savings_usd or 0), 6),
                    "actual_cost_usd": round(float(r.actual_cost_usd or 0), 6),
                    "avg_duration_ms": round(float(r.avg_duration_ms or 0), 1),
                    "error_count": int(r.error_count or 0),
                }
                for r in rows
            ]
        except Exception:
            logger.warning("planner_usage_time_series_failed", exc_info=True)
            return []
