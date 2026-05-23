"""Self-scoped account usage rollups across Chat and Coder metering logs.

This module intentionally exposes a user/org billing vocabulary. Provider actual
cost stays in admin/operator surfaces; account views see configured usage price.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import sqlalchemy as sa
from sqlalchemy import case, func, select

from ..auth import UserInfo
from ..db.engine import async_session
from ..db.models import PlannerUsageLog, YarnUsageLog


def account_usage_identity_candidates(user: UserInfo, extra_user_ids: list[str] | None = None) -> list[str]:
    """Return user ids that may legitimately represent this account in metering logs."""
    raw = [
        user.user_id,
        user.username,
        user.email,
        *(extra_user_ids or []),
    ]
    values: list[str] = []
    seen: set[str] = set()
    for value in raw:
        cleaned = str(value or "").strip()[:256]
        if not cleaned or cleaned == "unknown":
            continue
        variants = [cleaned]
        if "@" in cleaned:
            variants.append(cleaned.lower())
        for variant in variants:
            if variant and variant not in seen:
                seen.add(variant)
                values.append(variant)
    return values


def _empty_summary(source: str) -> dict[str, Any]:
    return {
        "source": source,
        "requests": 0,
        "tokens_in": 0,
        "tokens_out": 0,
        "total_tokens": 0,
        "tokens_cached": 0,
        "tokens_cache_write": 0,
        "price_usd": 0.0,
        "no_cache_price_usd": 0.0,
        "cache_discount_usd": 0.0,
        "avg_latency_ms": 0.0,
        "error_count": 0,
    }


def _summary_from_row(row: Any, source: str) -> dict[str, Any]:
    requests = int(row.requests or 0)
    tokens_in = int(row.tokens_in or 0)
    tokens_out = int(row.tokens_out or 0)
    return {
        "source": source,
        "requests": requests,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "total_tokens": tokens_in + tokens_out,
        "tokens_cached": int(row.tokens_cached or 0),
        "tokens_cache_write": int(row.tokens_cache_write or 0),
        "price_usd": round(float(row.price_usd or 0), 8),
        "no_cache_price_usd": round(float(row.no_cache_price_usd or 0), 8),
        "cache_discount_usd": round(float(row.cache_discount_usd or 0), 8),
        "avg_latency_ms": round(float(row.avg_latency_ms or 0), 1),
        "error_count": int(row.error_count or 0),
    }


def _total_summary(chat: dict[str, Any], coder: dict[str, Any]) -> dict[str, Any]:
    requests = int(chat["requests"]) + int(coder["requests"])
    total = _empty_summary("total")
    total["requests"] = requests
    for key in ("tokens_in", "tokens_out", "total_tokens", "tokens_cached", "tokens_cache_write", "error_count"):
        total[key] = int(chat[key]) + int(coder[key])
    for key in ("price_usd", "no_cache_price_usd", "cache_discount_usd"):
        total[key] = round(float(chat[key]) + float(coder[key]), 8)
    total["avg_latency_ms"] = (
        round(
            (
                (float(chat["avg_latency_ms"]) * int(chat["requests"]))
                + (float(coder["avg_latency_ms"]) * int(coder["requests"]))
            )
            / requests,
            1,
        )
        if requests > 0
        else 0.0
    )
    return total


async def _aggregate_summary(
    session: Any,
    model: Any,
    *,
    user_ids: list[str],
    cutoff: datetime,
    source: str,
    error_expr: Any,
) -> dict[str, Any]:
    if not user_ids:
        return _empty_summary(source)
    stmt = (
        select(
            func.count().label("requests"),
            func.coalesce(func.sum(model.tokens_in), 0).label("tokens_in"),
            func.coalesce(func.sum(model.tokens_out), 0).label("tokens_out"),
            func.coalesce(func.sum(model.tokens_cached), 0).label("tokens_cached"),
            func.coalesce(func.sum(model.tokens_cache_write), 0).label("tokens_cache_write"),
            func.coalesce(func.sum(model.estimated_cost_usd), 0).label("price_usd"),
            func.coalesce(func.sum(model.estimated_no_cache_cost_usd), 0).label("no_cache_price_usd"),
            func.coalesce(func.sum(model.cache_savings_usd), 0).label("cache_discount_usd"),
            func.coalesce(func.avg(model.latency_ms), 0).label("avg_latency_ms"),
            func.coalesce(func.sum(case((error_expr, 1), else_=0)), 0).label("error_count"),
        )
        .where(model.user_id.in_(user_ids))
        .where(model.created_at >= cutoff)
    )
    return _summary_from_row((await session.execute(stmt)).one(), source)


def _bucket_iso(value: datetime | None) -> str:
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()


def _empty_bucket(bucket: str) -> dict[str, Any]:
    return {
        "bucket": bucket,
        "chat_requests": 0,
        "coder_requests": 0,
        "requests": 0,
        "tokens_in": 0,
        "tokens_out": 0,
        "total_tokens": 0,
        "tokens_cached": 0,
        "tokens_cache_write": 0,
        "price_usd": 0.0,
        "no_cache_price_usd": 0.0,
        "cache_discount_usd": 0.0,
        "avg_latency_ms": 0.0,
        "error_count": 0,
    }


def _merge_metering(target: dict[str, Any], row: Any) -> None:
    for key in ("tokens_in", "tokens_out", "tokens_cached", "tokens_cache_write", "error_count"):
        target[key] = int(target[key]) + int(getattr(row, key, 0) or 0)
    target["total_tokens"] = int(target["tokens_in"]) + int(target["tokens_out"])
    for key in ("price_usd", "no_cache_price_usd", "cache_discount_usd"):
        target[key] = round(float(target[key]) + float(getattr(row, key, 0) or 0), 8)


def _merge_bucket(target: dict[str, Any], row: Any, request_key: str) -> None:
    requests = int(row.requests or 0)
    previous_requests = int(target["requests"])
    target[request_key] = int(target[request_key]) + requests
    target["requests"] = previous_requests + requests
    _merge_metering(target, row)
    if target["requests"] > 0:
        target["avg_latency_ms"] = round(
            ((float(target["avg_latency_ms"]) * previous_requests) + (float(row.avg_latency_ms or 0) * requests))
            / int(target["requests"]),
            1,
        )


async def _aggregate_series(
    session: Any,
    model: Any,
    *,
    user_ids: list[str],
    cutoff: datetime,
    error_expr: Any,
) -> list[Any]:
    if not user_ids:
        return []
    bucket_col = func.date_trunc(sa.literal_column("'hour'"), model.created_at).label("bucket")
    stmt = (
        select(
            bucket_col,
            func.count().label("requests"),
            func.coalesce(func.sum(model.tokens_in), 0).label("tokens_in"),
            func.coalesce(func.sum(model.tokens_out), 0).label("tokens_out"),
            func.coalesce(func.sum(model.tokens_cached), 0).label("tokens_cached"),
            func.coalesce(func.sum(model.tokens_cache_write), 0).label("tokens_cache_write"),
            func.coalesce(func.sum(model.estimated_cost_usd), 0).label("price_usd"),
            func.coalesce(func.sum(model.estimated_no_cache_cost_usd), 0).label("no_cache_price_usd"),
            func.coalesce(func.sum(model.cache_savings_usd), 0).label("cache_discount_usd"),
            func.coalesce(func.avg(model.latency_ms), 0).label("avg_latency_ms"),
            func.coalesce(func.sum(case((error_expr, 1), else_=0)), 0).label("error_count"),
        )
        .where(model.user_id.in_(user_ids))
        .where(model.created_at >= cutoff)
        .group_by(bucket_col)
        .order_by(bucket_col.desc())
    )
    return list((await session.execute(stmt)).all())


def _empty_key_row(key_id: str, key_name: str, key_prefix: str, auth_method: str) -> dict[str, Any]:
    row = _empty_bucket("")
    row.pop("bucket", None)
    row.update(
        {
            "key_id": key_id,
            "key_name": key_name,
            "key_prefix": key_prefix,
            "auth_method": auth_method,
        }
    )
    return row


def _key_values(row: Any) -> tuple[str, str, str, str]:
    auth_method = str(row.auth_method or "account")
    key_id = str(row.auth_key_id or "")
    key_name = str(row.auth_key_name or "")
    key_prefix = str(row.auth_key_prefix or "")
    if key_id:
        return key_id, key_name or key_prefix or "API key", key_prefix, auth_method
    user_id = str(row.user_id or "account")
    return f"account:{user_id}", "Account session / historical", "", auth_method


async def _aggregate_key_rows(
    session: Any,
    model: Any,
    *,
    user_ids: list[str],
    cutoff: datetime,
    error_expr: Any,
) -> list[Any]:
    if not user_ids:
        return []
    stmt = (
        select(
            model.user_id,
            model.auth_method,
            model.auth_key_id,
            model.auth_key_name,
            model.auth_key_prefix,
            func.count().label("requests"),
            func.coalesce(func.sum(model.tokens_in), 0).label("tokens_in"),
            func.coalesce(func.sum(model.tokens_out), 0).label("tokens_out"),
            func.coalesce(func.sum(model.tokens_cached), 0).label("tokens_cached"),
            func.coalesce(func.sum(model.tokens_cache_write), 0).label("tokens_cache_write"),
            func.coalesce(func.sum(model.estimated_cost_usd), 0).label("price_usd"),
            func.coalesce(func.sum(model.estimated_no_cache_cost_usd), 0).label("no_cache_price_usd"),
            func.coalesce(func.sum(model.cache_savings_usd), 0).label("cache_discount_usd"),
            func.coalesce(func.avg(model.latency_ms), 0).label("avg_latency_ms"),
            func.coalesce(func.sum(case((error_expr, 1), else_=0)), 0).label("error_count"),
        )
        .where(model.user_id.in_(user_ids))
        .where(model.created_at >= cutoff)
        .group_by(model.user_id, model.auth_method, model.auth_key_id, model.auth_key_name, model.auth_key_prefix)
    )
    return list((await session.execute(stmt)).all())


def _merge_key_rows(target: dict[str, dict[str, Any]], rows: list[Any], request_key: str) -> None:
    for row in rows:
        key_id, key_name, key_prefix, auth_method = _key_values(row)
        item = target.setdefault(key_id, _empty_key_row(key_id, key_name, key_prefix, auth_method))
        requests = int(row.requests or 0)
        previous_requests = int(item["requests"])
        item[request_key] = int(item[request_key]) + requests
        item["requests"] = previous_requests + requests
        _merge_metering(item, row)
        if item["requests"] > 0:
            item["avg_latency_ms"] = round(
                ((float(item["avg_latency_ms"]) * previous_requests) + (float(row.avg_latency_ms or 0) * requests))
                / int(item["requests"]),
                1,
            )


async def build_account_usage_dashboard(user_ids: list[str], *, since_hours: int = 720) -> dict[str, Any]:
    cutoff = datetime.now(tz=UTC) - timedelta(hours=since_hours)
    async with async_session() as session:
        chat = await _aggregate_summary(
            session,
            PlannerUsageLog,
            user_ids=user_ids,
            cutoff=cutoff,
            source="chat",
            error_expr=PlannerUsageLog.has_error == True,
        )
        coder = await _aggregate_summary(
            session,
            YarnUsageLog,
            user_ids=user_ids,
            cutoff=cutoff,
            source="coder",
            error_expr=YarnUsageLog.finish_reason.in_(["error", "tool_loop_limit_exceeded"]),
        )
        chat_rows = await _aggregate_series(
            session,
            PlannerUsageLog,
            user_ids=user_ids,
            cutoff=cutoff,
            error_expr=PlannerUsageLog.has_error == True,
        )
        coder_rows = await _aggregate_series(
            session,
            YarnUsageLog,
            user_ids=user_ids,
            cutoff=cutoff,
            error_expr=YarnUsageLog.finish_reason.in_(["error", "tool_loop_limit_exceeded"]),
        )
        chat_key_rows = await _aggregate_key_rows(
            session,
            PlannerUsageLog,
            user_ids=user_ids,
            cutoff=cutoff,
            error_expr=PlannerUsageLog.has_error == True,
        )
        coder_key_rows = await _aggregate_key_rows(
            session,
            YarnUsageLog,
            user_ids=user_ids,
            cutoff=cutoff,
            error_expr=YarnUsageLog.finish_reason.in_(["error", "tool_loop_limit_exceeded"]),
        )

    buckets: dict[str, dict[str, Any]] = {}
    for row in chat_rows:
        key = _bucket_iso(row.bucket)
        if key:
            _merge_bucket(buckets.setdefault(key, _empty_bucket(key)), row, "chat_requests")
    for row in coder_rows:
        key = _bucket_iso(row.bucket)
        if key:
            _merge_bucket(buckets.setdefault(key, _empty_bucket(key)), row, "coder_requests")

    by_key: dict[str, dict[str, Any]] = {}
    _merge_key_rows(by_key, chat_key_rows, "chat_requests")
    _merge_key_rows(by_key, coder_key_rows, "coder_requests")

    return {
        "period_hours": since_hours,
        "summary": {
            "chat": chat,
            "coder": coder,
            "total": _total_summary(chat, coder),
        },
        "series": sorted(buckets.values(), key=lambda item: item["bucket"], reverse=True),
        "by_key": sorted(by_key.values(), key=lambda item: float(item["price_usd"]), reverse=True),
        "price_basis": "price_usd uses the configured model rate card and cache pricing for user/org billing views.",
    }
