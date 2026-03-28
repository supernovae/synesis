"""Yarn data aggregation service — queries yarn_sessions and yarn_usage_log."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import case, func, select, text

from ..db.engine import async_session
from ..db.models import YarnSafetyEvent, YarnSession, YarnSessionEvent, YarnUsageLog

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
        elif scope_org_id:
            base = base.where(YarnUsageLog.org_id == scope_org_id)

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

        active_sessions_base = select(YarnSession).where(YarnSession.last_active_at >= cutoff)
        if scope_user_id:
            active_sessions_base = active_sessions_base.where(YarnSession.user_id == scope_user_id)
        elif scope_org_id:
            active_sessions_base = active_sessions_base.where(YarnSession.org_id == scope_org_id)

        active_sessions_res = await session.execute(
            select(func.count()).select_from(active_sessions_base.subquery())
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
    scope_org_id: str = "",
    active_since_hours: int | None = 168,
) -> dict:
    async with async_session() as session:
        base = select(YarnSession)
        if scope_user_id:
            base = base.where(YarnSession.user_id == scope_user_id)
        elif scope_org_id:
            base = base.where(YarnSession.org_id == scope_org_id)
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
            "org_id": r.org_id,
            "username": r.username,
            "role": r.role,
            "conversation_id": r.conversation_id,
            "client_kind": getattr(r, "client_kind", "unknown"),
            "provider": r.provider,
            "model": r.model,
            "total_tokens_in": r.total_tokens_in,
            "total_tokens_out": r.total_tokens_out,
            "total_tokens_cached": r.total_tokens_cached,
            "total_tokens_saved": getattr(r, "total_tokens_saved", 0) or 0,
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


async def get_yarn_session_detail(
    session_key: str,
    scope_user_id: str = "",
    scope_org_id: str = "",
) -> dict | None:
    async with async_session() as session:
        stmt = select(YarnSession).where(YarnSession.session_key == session_key).limit(1)
        if scope_user_id:
            stmt = stmt.where(YarnSession.user_id == scope_user_id)
        elif scope_org_id:
            stmt = stmt.where(YarnSession.org_id == scope_org_id)
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
        if scope_user_id:
            req_stmt = req_stmt.where(YarnUsageLog.user_id == scope_user_id)
        elif scope_org_id:
            req_stmt = req_stmt.where(YarnUsageLog.org_id == scope_org_id)
        req_result = await session.execute(req_stmt)
        requests = req_result.scalars().all()

        events_stmt = (
            select(YarnSessionEvent)
            .where(YarnSessionEvent.session_key == session_key)
            .order_by(YarnSessionEvent.created_at.desc())
            .limit(200)
        )
        events_result = await session.execute(events_stmt)
        events = events_result.scalars().all()

    return {
        "session": {
            "id": r.id,
            "session_key": r.session_key,
            "user_id": r.user_id,
            "org_id": r.org_id,
            "username": r.username,
            "role": r.role,
            "conversation_id": r.conversation_id,
            "client_kind": getattr(r, "client_kind", "unknown"),
            "provider": r.provider,
            "model": r.model,
            "total_tokens_in": r.total_tokens_in,
            "total_tokens_out": r.total_tokens_out,
            "total_tokens_cached": r.total_tokens_cached,
            "total_tokens_saved": getattr(r, "total_tokens_saved", 0) or 0,
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
                "tokens_saved_by_reduction": getattr(rq, "tokens_saved_by_reduction", 0) or 0,
                "latency_ms": round(rq.latency_ms, 1),
                "cost_usd": round(rq.cost_usd, 6),
                "escalated": rq.escalated,
                "tool_calls_count": rq.tool_calls_count,
                "finish_reason": rq.finish_reason,
                "created_at": rq.created_at.isoformat() if rq.created_at else None,
            }
            for rq in requests
        ],
        "events": [
            {
                "id": ev.id,
                "event_kind": ev.event_kind,
                "component": ev.component,
                "detail": ev.detail,
                "request_id": ev.request_id,
                "metadata_json": ev.metadata_json,
                "created_at": ev.created_at.isoformat() if ev.created_at else None,
            }
            for ev in events
        ],
    }


# ── Events / errors log ──────────────────────────────────────────────────────


async def list_yarn_events(
    page: int = 1,
    page_size: int = 50,
    scope_user_id: str = "",
    scope_org_id: str = "",
    since_hours: int = 24,
    errors_only: bool = False,
) -> dict:
    cutoff = _cutoff(since_hours)
    async with async_session() as session:
        base = select(YarnUsageLog).where(YarnUsageLog.created_at >= cutoff)
        if scope_user_id:
            base = base.where(YarnUsageLog.user_id == scope_user_id)
        elif scope_org_id:
            base = base.where(YarnUsageLog.org_id == scope_org_id)
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
            "org_id": r.org_id,
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
    scope_org_id: str = "",
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
            AND (:oid = '' OR org_id = :oid)
            GROUP BY bucket
            ORDER BY bucket
        """)
        result = await session.execute(
            stmt,
            {
                "cutoff": cutoff,
                "bucket": bucket_minutes,
                "uid": scope_user_id or "",
                "oid": scope_org_id or "",
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


# ── Session intelligence summary ──────────────────────────────────────────────


async def get_yarn_intelligence(
    since_hours: int = 24,
    scope_user_id: str = "",
    scope_org_id: str = "",
) -> dict:
    cutoff = _cutoff(since_hours)
    async with async_session() as session:
        base = select(YarnUsageLog).where(YarnUsageLog.created_at >= cutoff)
        if scope_user_id:
            base = base.where(YarnUsageLog.user_id == scope_user_id)
        elif scope_org_id:
            base = base.where(YarnUsageLog.org_id == scope_org_id)
        sub = base.subquery()

        agg = await session.execute(
            select(
                func.count().label("requests"),
                func.coalesce(func.avg(sub.c.tool_calls_count), 0).label("avg_tool_calls"),
                func.coalesce(func.sum(sub.c.tokens_cached), 0).label("cached_tokens"),
                func.coalesce(func.sum(sub.c.tokens_in + sub.c.tokens_out), 0).label("total_tokens"),
                func.coalesce(func.sum(case((sub.c.finish_reason == "tool_use", 1), else_=0)), 0).label("tool_use_stops"),
                func.coalesce(func.sum(case((sub.c.finish_reason.in_(["error", "tool_loop_limit_exceeded"]), 1), else_=0)), 0).label("error_like"),
            ).select_from(sub)
        )
        row = agg.one()

        top_models_res = await session.execute(
            select(
                YarnUsageLog.model,
                func.count().label("requests"),
                func.coalesce(func.sum(YarnUsageLog.cost_usd), 0).label("cost_usd"),
            )
            .where(YarnUsageLog.created_at >= cutoff)
            .where(text(":uid = '' OR user_id = :uid"))
            .where(text(":oid = '' OR org_id = :oid"))
            .params(uid=scope_user_id or "", oid=scope_org_id or "")
            .group_by(YarnUsageLog.model)
            .order_by(text("requests DESC"))
            .limit(5)
        )
        top_models = [
            {
                "model": (r.model or "unknown"),
                "requests": int(r.requests or 0),
                "cost_usd": round(float(r.cost_usd or 0), 4),
            }
            for r in top_models_res
        ]

        finish_reason_res = await session.execute(
            select(YarnUsageLog.finish_reason, func.count().label("count"))
            .where(YarnUsageLog.created_at >= cutoff)
            .where(text(":uid = '' OR user_id = :uid"))
            .where(text(":oid = '' OR org_id = :oid"))
            .params(uid=scope_user_id or "", oid=scope_org_id or "")
            .group_by(YarnUsageLog.finish_reason)
            .order_by(text("count DESC"))
            .limit(8)
        )
        finish_reason_counts = {
            (r.finish_reason or "unknown"): int(r.count or 0)
            for r in finish_reason_res
        }

    requests = int(row.requests or 0)
    total_tokens = int(row.total_tokens or 0)
    cached_tokens = int(row.cached_tokens or 0)
    cache_hit_estimate = (cached_tokens / total_tokens) if total_tokens else 0.0

    return {
        "since_hours": since_hours,
        "requests": requests,
        "avg_tool_calls_per_request": round(float(row.avg_tool_calls or 0), 2),
        "cache_hit_estimate": round(cache_hit_estimate, 4),
        "tool_use_stop_rate": round((int(row.tool_use_stops or 0) / requests), 4) if requests else 0.0,
        "error_like_rate": round((int(row.error_like or 0) / requests), 4) if requests else 0.0,
        "top_models": top_models,
        "finish_reason_counts": finish_reason_counts,
    }


# ── Safety events ─────────────────────────────────────────────────────────────


async def list_yarn_safety_events(
    page: int = 1,
    page_size: int = 50,
    scope_user_id: str = "",
    scope_org_id: str = "",
    since_hours: int = 24,
    event_kind: str | None = None,
) -> dict:
    cutoff = _cutoff(since_hours)
    async with async_session() as session:
        base = select(YarnSafetyEvent).where(YarnSafetyEvent.created_at >= cutoff)
        if scope_user_id:
            base = base.where(YarnSafetyEvent.user_id == scope_user_id)
        elif scope_org_id:
            base = base.where(YarnSafetyEvent.org_id == scope_org_id)
        if event_kind:
            base = base.where(YarnSafetyEvent.event_kind == event_kind)

        total = (await session.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0

        offset = (page - 1) * page_size
        stmt = base.order_by(YarnSafetyEvent.created_at.desc()).offset(offset).limit(page_size)
        result = await session.execute(stmt)
        rows = result.scalars().all()

    events = [
        {
            "id": r.id,
            "session_key": r.session_key,
            "user_id": r.user_id,
            "org_id": r.org_id,
            "event_kind": r.event_kind,
            "detail": r.detail,
            "repeat_count": r.repeat_count,
            "tokens_burned": r.tokens_burned,
            "consecutive_tool_calls": r.consecutive_tool_calls,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
    return {"events": events, "total": total}


async def get_yarn_safety_summary(
    since_hours: int = 24,
    scope_user_id: str = "",
    scope_org_id: str = "",
) -> dict:
    cutoff = _cutoff(since_hours)
    async with async_session() as session:
        base = select(YarnSafetyEvent).where(YarnSafetyEvent.created_at >= cutoff)
        if scope_user_id:
            base = base.where(YarnSafetyEvent.user_id == scope_user_id)
        elif scope_org_id:
            base = base.where(YarnSafetyEvent.org_id == scope_org_id)
        sub = base.subquery()

        total = (await session.execute(select(func.count()).select_from(sub))).scalar() or 0

        by_kind_result = await session.execute(
            select(sub.c.event_kind, func.count().label("count"))
            .select_from(sub)
            .group_by(sub.c.event_kind)
            .order_by(text("count DESC"))
        )
        by_kind = {r.event_kind: int(r.count) for r in by_kind_result}

        total_tokens_burned = (
            await session.execute(
                select(func.coalesce(func.sum(sub.c.tokens_burned), 0)).select_from(sub)
            )
        ).scalar() or 0

    return {
        "since_hours": since_hours,
        "total_events": total,
        "by_kind": by_kind,
        "total_tokens_burned": int(total_tokens_burned),
    }


# ── Purge ─────────────────────────────────────────────────────────────────────


async def purge_yarn_sessions(
    older_than_days: int = 30,
    session_key_prefix: str = "",
    dry_run: bool = True,
) -> dict:
    """Delete sessions (and associated usage/events) older than a threshold.

    Returns counts of rows that would be (or were) deleted.
    """
    cutoff = datetime.now(UTC) - timedelta(days=older_than_days)
    async with async_session() as session:
        base = select(YarnSession.session_key).where(YarnSession.last_active_at < cutoff)
        if session_key_prefix:
            base = base.where(YarnSession.session_key.like(f"{session_key_prefix}%"))
        result = await session.execute(base)
        keys = [r[0] for r in result.all()]
        if not keys:
            return {"dry_run": dry_run, "sessions": 0, "usage_rows": 0, "events": 0}

        usage_count_q = select(func.count()).select_from(
            select(YarnUsageLog).where(YarnUsageLog.session_key.in_(keys)).subquery()
        )
        usage_count = (await session.execute(usage_count_q)).scalar() or 0

        events_count_q = select(func.count()).select_from(
            select(YarnSessionEvent).where(YarnSessionEvent.session_key.in_(keys)).subquery()
        )
        events_count = (await session.execute(events_count_q)).scalar() or 0

        if dry_run:
            return {
                "dry_run": True,
                "sessions": len(keys),
                "usage_rows": int(usage_count),
                "events": int(events_count),
            }

        await session.execute(
            YarnSessionEvent.__table__.delete().where(YarnSessionEvent.session_key.in_(keys))
        )
        await session.execute(
            YarnUsageLog.__table__.delete().where(YarnUsageLog.session_key.in_(keys))
        )
        await session.execute(
            YarnSafetyEvent.__table__.delete().where(YarnSafetyEvent.session_key.in_(keys))
        )
        await session.execute(
            YarnSession.__table__.delete().where(YarnSession.session_key.in_(keys))
        )
        await session.commit()

    logger.info("purged_yarn_sessions older_than_days=%d sessions=%d", older_than_days, len(keys))
    return {
        "dry_run": False,
        "sessions": len(keys),
        "usage_rows": int(usage_count),
        "events": int(events_count),
    }
