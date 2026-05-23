"""User-scoped usage audit rows with no prompt/tool text exposure."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select

from ..db.engine import async_session
from ..db.models import PlannerUsageLog, YarnUsageLog

_SAFE_PRIVACY = {
    "privacy_mode": "metering_audit",
    "redaction_status": "no_text_fields",
    "training_allowed": False,
    "raw_text_visible": False,
}


def _iso(value: datetime | None) -> str:
    if not value:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()


def _price(row: Any) -> float:
    return float(getattr(row, "estimated_cost_usd", 0.0) or 0.0)


def _breakdown(row: Any) -> dict[str, int | float]:
    tokens_in = int(getattr(row, "tokens_in", 0) or 0)
    tokens_out = int(getattr(row, "tokens_out", 0) or 0)
    cached = int(getattr(row, "tokens_cached", 0) or 0)
    uncached = int(getattr(row, "tokens_uncached_input", 0) or max(0, tokens_in - cached))
    cache_read = int(getattr(row, "tokens_cache_read", 0) or cached)
    cache_write = int(getattr(row, "tokens_cache_write", 0) or 0)
    price = _price(row)
    no_cache = float(getattr(row, "estimated_no_cache_cost_usd", 0.0) or price)
    discount = float(getattr(row, "cache_savings_usd", 0.0) or (no_cache - price))
    return {
        "tokens_uncached_input": uncached,
        "tokens_cache_read": cache_read,
        "tokens_cache_write": cache_write,
        "tokens_output": tokens_out,
        "input_price_usd": round(float(getattr(row, "input_cost_usd", 0.0) or 0.0), 8),
        "cache_read_price_usd": round(float(getattr(row, "cache_read_cost_usd", 0.0) or 0.0), 8),
        "cache_write_price_usd": round(float(getattr(row, "cache_write_cost_usd", 0.0) or 0.0), 8),
        "output_price_usd": round(float(getattr(row, "output_cost_usd", 0.0) or 0.0), 8),
        "no_cache_price_usd": round(no_cache, 8),
        "cache_discount_usd": round(discount, 8),
        "cache_hit_rate": round(cache_read / tokens_in, 4) if tokens_in > 0 else 0.0,
    }


def _key_fields(row: Any) -> dict[str, str]:
    auth_key_id = str(getattr(row, "auth_key_id", "") or "")
    auth_method = str(getattr(row, "auth_method", "") or "")
    return {
        "auth_method": auth_method,
        "key_id": auth_key_id,
        "key_name": str(getattr(row, "auth_key_name", "") or ""),
        "key_prefix": str(getattr(row, "auth_key_prefix", "") or ""),
    }


def _planner_row(row: PlannerUsageLog) -> dict[str, Any]:
    return {
        "source": "chat",
        "request_id": row.request_id,
        "trace_id": row.request_id,
        "created_at": _iso(row.created_at),
        "timestamp": row.created_at.timestamp() if row.created_at else 0,
        "model": row.model,
        "provider": "planner",
        "status": "error" if row.has_error else "ok",
        "has_error": bool(row.has_error),
        "latency_ms": float(row.latency_ms or 0),
        "tokens_in": int(row.tokens_in or 0),
        "tokens_out": int(row.tokens_out or 0),
        "tokens_cached": int(row.tokens_cached or 0),
        "total_tokens": int((row.tokens_in or 0) + (row.tokens_out or 0)),
        "price_usd": round(_price(row), 8),
        "pricing_source": row.pricing_source,
        **_key_fields(row),
        "billing_breakdown": _breakdown(row),
        **_SAFE_PRIVACY,
    }


def _yarn_row(row: YarnUsageLog) -> dict[str, Any]:
    return {
        "source": "coder",
        "request_id": row.request_id,
        "trace_id": row.request_id,
        "created_at": _iso(row.created_at),
        "timestamp": row.created_at.timestamp() if row.created_at else 0,
        "model": row.model,
        "provider": row.provider,
        "status": "error" if row.finish_reason in ("error", "tool_loop_limit_exceeded") else "ok",
        "has_error": row.finish_reason in ("error", "tool_loop_limit_exceeded"),
        "latency_ms": float(row.latency_ms or 0),
        "tokens_in": int(row.tokens_in or 0),
        "tokens_out": int(row.tokens_out or 0),
        "tokens_cached": int(row.tokens_cached or 0),
        "tokens_saved_by_reduction": int(row.tokens_saved_by_reduction or 0),
        "tool_calls_count": int(row.tool_calls_count or 0),
        "finish_reason": row.finish_reason,
        "total_tokens": int((row.tokens_in or 0) + (row.tokens_out or 0)),
        "price_usd": round(_price(row), 8),
        "pricing_source": row.pricing_source,
        **_key_fields(row),
        "billing_breakdown": _breakdown(row),
        **_SAFE_PRIVACY,
    }


async def list_user_usage_audit(
    user_id: str,
    *,
    user_ids: list[str] | None = None,
    since_hours: int = 720,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    cutoff = datetime.now(tz=UTC) - timedelta(hours=since_hours)
    fetch_limit = max(1, min(5000, limit + offset))
    scoped_user_ids = user_ids or [user_id]
    async with async_session() as session:
        planner_total = (
            await session.execute(
                select(func.count())
                .select_from(PlannerUsageLog)
                .where(PlannerUsageLog.user_id.in_(scoped_user_ids))
                .where(PlannerUsageLog.created_at >= cutoff)
            )
        ).scalar_one()
        yarn_total = (
            await session.execute(
                select(func.count())
                .select_from(YarnUsageLog)
                .where(YarnUsageLog.user_id.in_(scoped_user_ids))
                .where(YarnUsageLog.created_at >= cutoff)
            )
        ).scalar_one()
        planner_rows = (
            (
                await session.execute(
                    select(PlannerUsageLog)
                    .where(PlannerUsageLog.user_id.in_(scoped_user_ids))
                    .where(PlannerUsageLog.created_at >= cutoff)
                    .order_by(PlannerUsageLog.created_at.desc())
                    .limit(fetch_limit)
                )
            )
            .scalars()
            .all()
        )
        yarn_rows = (
            (
                await session.execute(
                    select(YarnUsageLog)
                    .where(YarnUsageLog.user_id.in_(scoped_user_ids))
                    .where(YarnUsageLog.created_at >= cutoff)
                    .order_by(YarnUsageLog.created_at.desc())
                    .limit(fetch_limit)
                )
            )
            .scalars()
            .all()
        )

    rows = [_planner_row(r) for r in planner_rows] + [_yarn_row(r) for r in yarn_rows]
    rows.sort(key=lambda r: float(r["timestamp"]), reverse=True)
    return {
        "since_hours": since_hours,
        "total": int(planner_total or 0) + int(yarn_total or 0),
        "offset": offset,
        "limit": limit,
        "requests": rows[offset : offset + limit],
    }


async def get_user_usage_audit_request(user_id: str, request_id: str) -> dict[str, Any] | None:
    return await get_user_usage_audit_request_for_ids([user_id], request_id)


async def get_user_usage_audit_request_for_ids(user_ids: list[str], request_id: str) -> dict[str, Any] | None:
    async with async_session() as session:
        planner = (
            await session.execute(
                select(PlannerUsageLog)
                .where(PlannerUsageLog.user_id.in_(user_ids))
                .where(PlannerUsageLog.request_id == request_id)
            )
        ).scalar_one_or_none()
        if planner is not None:
            return _planner_row(planner)
        yarn = (
            await session.execute(
                select(YarnUsageLog)
                .where(YarnUsageLog.user_id.in_(user_ids))
                .where(YarnUsageLog.request_id == request_id)
            )
        ).scalar_one_or_none()
        if yarn is not None:
            return _yarn_row(yarn)
    return None
