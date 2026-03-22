"""Yarn data aggregation service — queries yarn_sessions and yarn_usage_log."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import case, func, select, text

from ..db.engine import async_session
from ..db.models import YarnSession, YarnUsageLog

logger = logging.getLogger("synesis.admin.yarn_service")


def _cutoff(since_hours: int) -> datetime:
    return datetime.now(UTC) - timedelta(hours=since_hours)


# ── Overview summary ──────────────────────────────────────────────────────────


async def get_yarn_overview(
    since_hours: int = 24,
    scope_user_id: str = "",
    scope_org_id: str = "",
) -> dict:
    cutoff = _cutoff(since_hours)
    async with async_session() as session:
        base = select(YarnUsageLog).where(YarnUsageLog.created_at >= cutoff)
        if scope_user_id:
            base = base.where(YarnUsageLog.user_id == scope_user_id)

        sub = base.subquery()

        agg = await session.execute(
            select(
                func.count().label("total_requests"),
                func.coalesce(func.sum(sub.c.tokens_in), 0).label("total_tokens_in"),
                func.coalesce(func.sum(sub.c.tokens_out), 0).label("total_tokens_out"),
                func.coalesce(func.sum(sub.c.tokens_cached), 0).label("total_tokens_cached"),
                func.coalesce(func.sum(sub.c.cost_usd), 0).label("total_cost_usd"),
                func.coalesce(func.avg(sub.c.latency_ms), 0).label("avg_latency_ms"),
                func.coalesce(func.max(sub.c.latency_ms), 0).label("p99_latency_ms"),
                func.coalesce(
                    func.sum(case((sub.c.escalated == True, 1), else_=0)),
                    0,
                ).label("escalation_count"),
                func.coalesce(func.sum(sub.c.tool_calls_count), 0).label("total_tool_calls"),
            ).select_from(sub)
        )
        row = agg.one()

        error_count_res = await session.execute(
            select(func.count()).select_from(
                base.where(YarnUsageLog.finish_reason.in_(["error", "tool_loop_limit_exceeded"])).subquery()
            )
        )
        error_count = error_count_res.scalar() or 0

        active_sessions_res = await session.execute(
            select(func.count()).select_from(select(YarnSession).where(YarnSession.last_active_at >= cutoff).subquery())
        )
        active_sessions = active_sessions_res.scalar() or 0

    total_reqs = int(row.total_requests)
    return {
        "since_hours": since_hours,
        "total_requests": total_reqs,
        "total_tokens_in": int(row.total_tokens_in),
        "total_tokens_out": int(row.total_tokens_out),
        "total_tokens_cached": int(row.total_tokens_cached),
        "total_cost_usd": round(float(row.total_cost_usd), 4),
        "avg_latency_ms": round(float(row.avg_latency_ms), 1),
        "p99_latency_ms": round(float(row.p99_latency_ms), 1),
        "error_count": error_count,
        "error_rate": round(error_count / total_reqs, 4) if total_reqs else 0,
        "escalation_count": int(row.escalation_count),
        "total_tool_calls": int(row.total_tool_calls),
        "active_sessions": active_sessions,
    }


# ── Sessions list ─────────────────────────────────────────────────────────────


async def list_yarn_sessions(
    page: int = 1,
    page_size: int = 20,
    scope_user_id: str = "",
    active_since_hours: int | None = None,
) -> dict:
    async with async_session() as session:
        base = select(YarnSession)
        if scope_user_id:
            base = base.where(YarnSession.user_id == scope_user_id)
        if active_since_hours:
            base = base.where(YarnSession.last_active_at >= _cutoff(active_since_hours))

        total = (await session.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0

        offset = (page - 1) * page_size
        stmt = base.order_by(YarnSession.last_active_at.desc()).offset(offset).limit(page_size)
        result = await session.execute(stmt)
        rows = result.scalars().all()

    sessions = [
        {
            "id": r.id,
            "session_key": r.session_key,
            "user_id": r.user_id,
            "username": r.username,
            "role": r.role,
            "conversation_id": r.conversation_id,
            "provider": r.provider,
            "model": r.model,
            "total_tokens_in": r.total_tokens_in,
            "total_tokens_out": r.total_tokens_out,
            "total_tokens_cached": r.total_tokens_cached,
            "total_cost_usd": round(r.total_cost_usd, 4),
            "request_count": r.request_count,
            "escalation_count": r.escalation_count,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "last_active_at": r.last_active_at.isoformat() if r.last_active_at else None,
        }
        for r in rows
    ]
    return {"sessions": sessions, "total": total}


# ── Session detail ────────────────────────────────────────────────────────────


async def get_yarn_session_detail(session_key: str) -> dict | None:
    async with async_session() as session:
        stmt = select(YarnSession).where(YarnSession.session_key == session_key).limit(1)
        result = await session.execute(stmt)
        r = result.scalar_one_or_none()
        if not r:
            return None

        req_stmt = (
            select(YarnUsageLog)
            .where(YarnUsageLog.session_key == session_key)
            .order_by(YarnUsageLog.created_at.desc())
            .limit(100)
        )
        req_result = await session.execute(req_stmt)
        requests = req_result.scalars().all()

    return {
        "session": {
            "id": r.id,
            "session_key": r.session_key,
            "user_id": r.user_id,
            "username": r.username,
            "role": r.role,
            "conversation_id": r.conversation_id,
            "provider": r.provider,
            "model": r.model,
            "total_tokens_in": r.total_tokens_in,
            "total_tokens_out": r.total_tokens_out,
            "total_tokens_cached": r.total_tokens_cached,
            "total_cost_usd": round(r.total_cost_usd, 4),
            "request_count": r.request_count,
            "escalation_count": r.escalation_count,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "last_active_at": r.last_active_at.isoformat() if r.last_active_at else None,
        },
        "requests": [
            {
                "id": rq.id,
                "request_id": rq.request_id,
                "provider": rq.provider,
                "model": rq.model,
                "tokens_in": rq.tokens_in,
                "tokens_out": rq.tokens_out,
                "tokens_cached": rq.tokens_cached,
                "latency_ms": round(rq.latency_ms, 1),
                "cost_usd": round(rq.cost_usd, 6),
                "escalated": rq.escalated,
                "tool_calls_count": rq.tool_calls_count,
                "finish_reason": rq.finish_reason,
                "created_at": rq.created_at.isoformat() if rq.created_at else None,
            }
            for rq in requests
        ],
    }


# ── Events / errors log ──────────────────────────────────────────────────────


async def list_yarn_events(
    page: int = 1,
    page_size: int = 50,
    scope_user_id: str = "",
    since_hours: int = 24,
    errors_only: bool = False,
) -> dict:
    cutoff = _cutoff(since_hours)
    async with async_session() as session:
        base = select(YarnUsageLog).where(YarnUsageLog.created_at >= cutoff)
        if scope_user_id:
            base = base.where(YarnUsageLog.user_id == scope_user_id)
        if errors_only:
            base = base.where(
                (YarnUsageLog.escalated == True)
                | YarnUsageLog.finish_reason.in_(["error", "escalated", "tool_loop_limit_exceeded"])
            )

        total = (await session.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0

        offset = (page - 1) * page_size
        stmt = base.order_by(YarnUsageLog.created_at.desc()).offset(offset).limit(page_size)
        result = await session.execute(stmt)
        rows = result.scalars().all()

    events = [
        {
            "id": r.id,
            "session_key": r.session_key,
            "request_id": r.request_id,
            "user_id": r.user_id,
            "provider": r.provider,
            "model": r.model,
            "tokens_in": r.tokens_in,
            "tokens_out": r.tokens_out,
            "tokens_cached": r.tokens_cached,
            "latency_ms": round(r.latency_ms, 1),
            "cost_usd": round(r.cost_usd, 6),
            "escalated": r.escalated,
            "tool_calls_count": r.tool_calls_count,
            "finish_reason": r.finish_reason,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
    return {"events": events, "total": total}


# ── Performance time-series ───────────────────────────────────────────────────


async def get_yarn_performance(
    since_hours: int = 24,
    bucket_minutes: int = 15,
    scope_user_id: str = "",
) -> list[dict]:
    cutoff = _cutoff(since_hours)
    async with async_session() as session:
        stmt = text("""
            SELECT
                date_trunc('hour', created_at) +
                    (EXTRACT(minute FROM created_at)::int / :bucket * :bucket) * interval '1 minute'
                    AS bucket,
                COUNT(*)::int AS requests,
                COALESCE(SUM(tokens_in), 0)::int AS tokens_in,
                COALESCE(SUM(tokens_out), 0)::int AS tokens_out,
                COALESCE(SUM(tokens_cached), 0)::int AS tokens_cached,
                COALESCE(SUM(cost_usd), 0)::float AS cost_usd,
                COALESCE(AVG(latency_ms), 0)::float AS avg_latency_ms,
                COALESCE(MAX(latency_ms), 0)::float AS max_latency_ms,
                SUM(CASE WHEN escalated THEN 1 ELSE 0 END)::int AS escalations,
                SUM(CASE WHEN finish_reason IN ('error', 'tool_loop_limit_exceeded') THEN 1 ELSE 0 END)::int AS errors
            FROM yarn_usage_log
            WHERE created_at >= :cutoff
            AND (:uid = '' OR user_id = :uid)
            GROUP BY bucket
            ORDER BY bucket
        """)
        result = await session.execute(
            stmt,
            {
                "cutoff": cutoff,
                "bucket": bucket_minutes,
                "uid": scope_user_id or "",
            },
        )
        rows = result.mappings().all()

    return [
        {
            "bucket": r["bucket"].isoformat() if r["bucket"] else None,
            "requests": r["requests"],
            "tokens_in": r["tokens_in"],
            "tokens_out": r["tokens_out"],
            "tokens_cached": r["tokens_cached"],
            "cost_usd": round(r["cost_usd"], 4),
            "avg_latency_ms": round(r["avg_latency_ms"], 1),
            "max_latency_ms": round(r["max_latency_ms"], 1),
            "escalations": r["escalations"],
            "errors": r["errors"],
        }
        for r in rows
    ]


# ── User-scoped usage summary (for account page) ─────────────────────────────


async def get_user_yarn_usage(user_id: str, since_hours: int = 720) -> dict:
    cutoff = _cutoff(since_hours)
    async with async_session() as session:
        base = (
            select(
                func.count().label("total_requests"),
                func.coalesce(func.sum(YarnUsageLog.tokens_in), 0).label("tokens_in"),
                func.coalesce(func.sum(YarnUsageLog.tokens_out), 0).label("tokens_out"),
                func.coalesce(func.sum(YarnUsageLog.tokens_cached), 0).label("tokens_cached"),
                func.coalesce(func.sum(YarnUsageLog.cost_usd), 0).label("cost_usd"),
                func.coalesce(func.avg(YarnUsageLog.latency_ms), 0).label("avg_latency_ms"),
                func.coalesce(
                    func.sum(case((YarnUsageLog.escalated == True, 1), else_=0)),
                    0,
                ).label("escalations"),
                func.coalesce(
                    func.sum(case((YarnUsageLog.finish_reason.in_(["error", "tool_loop_limit_exceeded"]), 1), else_=0)),
                    0,
                ).label("errors"),
            )
            .where(YarnUsageLog.user_id == user_id)
            .where(YarnUsageLog.created_at >= cutoff)
        )
        row = (await session.execute(base)).one()

    return {
        "user_id": user_id,
        "since_hours": since_hours,
        "total_requests": int(row.total_requests),
        "tokens_in": int(row.tokens_in),
        "tokens_out": int(row.tokens_out),
        "tokens_cached": int(row.tokens_cached),
        "cost_usd": round(float(row.cost_usd), 4),
        "avg_latency_ms": round(float(row.avg_latency_ms), 1),
        "escalations": int(row.escalations),
        "errors": int(row.errors),
    }
