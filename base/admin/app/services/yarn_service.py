"""Yarn data aggregation service — queries yarn_sessions and yarn_usage_log."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import case, func, select, text

from ..db.engine import async_session
from ..db.models import PersonalAccessToken, YarnSafetyEvent, YarnSession, YarnSessionEvent, YarnUsageLog
from .archive_store import write_jsonl_archive

logger = logging.getLogger("synesis.admin.yarn_service")


def _cutoff(since_hours: int) -> datetime:
    return datetime.now(UTC) - timedelta(hours=since_hours)


def _row_dict(row: object) -> dict[str, Any]:
    return {col.name: getattr(row, col.name) for col in row.__table__.columns}


def _masked_external_bearer(user_id: str) -> str:
    suffix = user_id.rsplit("-", 1)[-1][-6:] if user_id else ""
    return f"External bearer ****{suffix}" if suffix else "External bearer"


def _user_display(user_id: str, username: str | None, pat_usernames: dict[str, str]) -> str:
    if username:
        return username
    pat_username = pat_usernames.get(user_id)
    if pat_username:
        return pat_username
    if "@" in user_id and "." in user_id.rsplit("@", 1)[-1]:
        return user_id.lower()
    if user_id.startswith("bearer-"):
        return _masked_external_bearer(user_id)
    return user_id or "Unknown user"


async def _pat_usernames_for(user_ids: list[str]) -> dict[str, str]:
    ids = [uid for uid in dict.fromkeys(user_ids) if uid and not uid.startswith("bearer-")]
    if not ids:
        return {}
    async with async_session() as session:
        rows = (
            await session.execute(
                select(PersonalAccessToken.user_id, PersonalAccessToken.username)
                .where(PersonalAccessToken.user_id.in_(ids))
                .order_by(PersonalAccessToken.last_used_at.desc().nullslast(), PersonalAccessToken.created_at.desc())
            )
        ).all()
    mapping: dict[str, str] = {}
    for user_id, username in rows:
        if user_id and username and user_id not in mapping:
            mapping[user_id] = username
    return mapping


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
                func.coalesce(func.sum(sub.c.estimated_cost_usd), 0).label("total_estimated_cost_usd"),
                func.coalesce(func.sum(sub.c.actual_cost_usd), 0).label("total_actual_cost_usd"),
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

        active_sessions_res = await session.execute(select(func.count()).select_from(active_sessions_base.subquery()))
        active_sessions = active_sessions_res.scalar() or 0

    total_reqs = int(row.total_requests)
    return {
        "since_hours": since_hours,
        "total_requests": total_reqs,
        "total_tokens_in": int(row.total_tokens_in),
        "total_tokens_out": int(row.total_tokens_out),
        "total_tokens_cached": int(row.total_tokens_cached),
        "total_estimated_cost_usd": round(float(row.total_estimated_cost_usd), 4),
        "total_actual_cost_usd": round(float(row.total_actual_cost_usd), 4),
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

    pat_usernames = await _pat_usernames_for([r.user_id for r in rows])
    sessions = [
        {
            "id": r.id,
            "session_key": r.session_key,
            "user_id": r.user_id,
            "org_id": r.org_id,
            "username": r.username,
            "user_display": _user_display(r.user_id, r.username, pat_usernames),
            "role": r.role,
            "conversation_id": r.conversation_id,
            "client_kind": getattr(r, "client_kind", "unknown"),
            "provider": r.provider,
            "model": r.model,
            "total_tokens_in": r.total_tokens_in,
            "total_tokens_out": r.total_tokens_out,
            "total_tokens_cached": r.total_tokens_cached,
            "total_tokens_saved": getattr(r, "total_tokens_saved", 0) or 0,
            "total_estimated_cost_usd": round(r.total_estimated_cost_usd, 4),
            "total_actual_cost_usd": round(r.total_actual_cost_usd, 4),
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

        req_base = select(YarnUsageLog).where(YarnUsageLog.session_key == session_key)
        if scope_user_id:
            req_base = req_base.where(YarnUsageLog.user_id == scope_user_id)
        elif scope_org_id:
            req_base = req_base.where(YarnUsageLog.org_id == scope_org_id)

        usage_rows_total = (await session.execute(select(func.count()).select_from(req_base.subquery()))).scalar() or 0
        session_request_count = int(r.request_count or 0)
        stale_usage_rows = usage_rows_total > session_request_count >= 0
        request_limit = min(100, session_request_count if stale_usage_rows else 100)

        req_stmt = req_base.order_by(YarnUsageLog.created_at.desc()).limit(request_limit)
        req_result = await session.execute(req_stmt)
        requests = req_result.scalars().all()

        events_stmt = (
            select(YarnSessionEvent)
            .where(YarnSessionEvent.session_key == session_key)
            .order_by(YarnSessionEvent.created_at.desc())
        )
        if scope_user_id:
            events_stmt = events_stmt.where(YarnSessionEvent.user_id == scope_user_id)
        elif scope_org_id:
            events_stmt = events_stmt.where(YarnSessionEvent.org_id == scope_org_id)
        if stale_usage_rows:
            request_ids = [rq.request_id for rq in requests if rq.request_id]
            earliest_request_at = min((rq.created_at for rq in requests if rq.created_at), default=None)
            if request_ids and earliest_request_at:
                events_stmt = events_stmt.where(
                    (YarnSessionEvent.request_id.in_(request_ids))
                    | (YarnSessionEvent.created_at >= earliest_request_at)
                )
            elif request_ids:
                events_stmt = events_stmt.where(YarnSessionEvent.request_id.in_(request_ids))
            elif earliest_request_at:
                events_stmt = events_stmt.where(YarnSessionEvent.created_at >= earliest_request_at)
            else:
                events_stmt = events_stmt.where(text("false"))
        events_stmt = events_stmt.limit(200)
        events_result = await session.execute(events_stmt)
        events = events_result.scalars().all()

    pat_usernames = await _pat_usernames_for([r.user_id])
    return {
        "session": {
            "id": r.id,
            "session_key": r.session_key,
            "user_id": r.user_id,
            "org_id": r.org_id,
            "username": r.username,
            "user_display": _user_display(r.user_id, r.username, pat_usernames),
            "role": r.role,
            "conversation_id": r.conversation_id,
            "client_kind": getattr(r, "client_kind", "unknown"),
            "provider": r.provider,
            "model": r.model,
            "total_tokens_in": r.total_tokens_in,
            "total_tokens_out": r.total_tokens_out,
            "total_tokens_cached": r.total_tokens_cached,
            "total_tokens_saved": getattr(r, "total_tokens_saved", 0) or 0,
            "total_estimated_cost_usd": round(r.total_estimated_cost_usd, 4),
            "total_actual_cost_usd": round(r.total_actual_cost_usd, 4),
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
                "estimated_cost_usd": round(rq.estimated_cost_usd, 6),
                "actual_cost_usd": round(rq.actual_cost_usd, 6),
                "pricing_source": getattr(rq, "pricing_source", "unknown") or "unknown",
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
        "integrity": {
            "usage_rows_total": int(usage_rows_total),
            "session_request_count": session_request_count,
            "truncated_to_session_request_count": bool(stale_usage_rows),
        },
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
            "estimated_cost_usd": round(r.estimated_cost_usd, 6),
            "actual_cost_usd": round(r.actual_cost_usd, 6),
            "pricing_source": getattr(r, "pricing_source", "unknown") or "unknown",
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
                COALESCE(SUM(estimated_cost_usd), 0)::float AS estimated_cost_usd,
                COALESCE(SUM(actual_cost_usd), 0)::float AS actual_cost_usd,
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
            "estimated_cost_usd": round(r["estimated_cost_usd"], 4),
            "actual_cost_usd": round(r["actual_cost_usd"], 4),
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
                func.coalesce(func.sum(YarnUsageLog.tokens_cache_write), 0).label("tokens_cache_write"),
                func.coalesce(func.sum(YarnUsageLog.estimated_no_cache_cost_usd), 0).label(
                    "estimated_no_cache_cost_usd"
                ),
                func.coalesce(func.sum(YarnUsageLog.cache_savings_usd), 0).label("cache_savings_usd"),
                func.coalesce(func.sum(YarnUsageLog.estimated_cost_usd), 0).label("estimated_cost_usd"),
                func.coalesce(func.sum(YarnUsageLog.actual_cost_usd), 0).label("actual_cost_usd"),
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
        "tokens_cache_write": int(row.tokens_cache_write),
        "estimated_no_cache_cost_usd": round(float(row.estimated_no_cache_cost_usd), 4),
        "cache_savings_usd": round(float(row.cache_savings_usd), 4),
        "estimated_cost_usd": round(float(row.estimated_cost_usd), 4),
        "actual_cost_usd": round(float(row.actual_cost_usd), 4),
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
                func.coalesce(func.sum(case((sub.c.finish_reason == "tool_use", 1), else_=0)), 0).label(
                    "tool_use_stops"
                ),
                func.coalesce(
                    func.sum(case((sub.c.finish_reason.in_(["error", "tool_loop_limit_exceeded"]), 1), else_=0)), 0
                ).label("error_like"),
            ).select_from(sub)
        )
        row = agg.one()

        top_models_res = await session.execute(
            select(
                YarnUsageLog.model,
                func.count().label("requests"),
                func.coalesce(func.sum(YarnUsageLog.estimated_cost_usd), 0).label("estimated_cost_usd"),
                func.coalesce(func.sum(YarnUsageLog.actual_cost_usd), 0).label("actual_cost_usd"),
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
                "estimated_cost_usd": round(float(r.estimated_cost_usd or 0), 4),
                "actual_cost_usd": round(float(r.actual_cost_usd or 0), 4),
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
        finish_reason_counts = {(r.finish_reason or "unknown"): int(r.count or 0) for r in finish_reason_res}

        edit_miss_rollup_sql = text(
            """
            WITH scoped_events AS (
              SELECT request_id, session_key
              FROM yarn_session_events
              WHERE event_kind = 'client_tool_error_observed'
                AND created_at >= :cutoff
                AND (:uid = '' OR user_id = :uid)
                AND (:oid = '' OR org_id = :oid)
                AND COALESCE(metadata_json->>'reason', '') = 'edit_context_miss'
            ),
            request_hits AS (
              SELECT DISTINCT request_id
              FROM scoped_events
              WHERE COALESCE(request_id, '') <> ''
            ),
            joined_usage AS (
              SELECT
                u.request_id,
                (COALESCE(u.tokens_in, 0) + COALESCE(u.tokens_out, 0))::bigint AS total_tokens,
                COALESCE(u.tokens_cached, 0)::bigint AS cached_tokens,
                CASE
                  WHEN COALESCE(u.actual_cost_usd, 0) > 0 THEN COALESCE(u.actual_cost_usd, 0)
                  ELSE COALESCE(u.estimated_cost_usd, 0)
                END::float AS effective_cost_usd
              FROM yarn_usage_log u
              JOIN request_hits rh ON rh.request_id = u.request_id
            )
            SELECT
              (SELECT COUNT(*)::int FROM scoped_events) AS miss_events,
              (SELECT COUNT(*)::int FROM request_hits) AS impacted_requests,
              (SELECT COUNT(*)::int FROM joined_usage) AS mapped_requests,
              (SELECT COUNT(DISTINCT session_key)::int FROM scoped_events) AS impacted_sessions,
              (SELECT COALESCE(SUM(total_tokens), 0)::bigint FROM joined_usage) AS impacted_tokens,
              (SELECT COALESCE(SUM(cached_tokens), 0)::bigint FROM joined_usage) AS impacted_cached_tokens,
              (SELECT COALESCE(SUM(effective_cost_usd), 0)::float FROM joined_usage) AS impacted_cost_usd
            """
        )
        edit_miss_rollup_row = (
            (
                await session.execute(
                    edit_miss_rollup_sql,
                    {
                        "cutoff": cutoff,
                        "uid": scope_user_id or "",
                        "oid": scope_org_id or "",
                    },
                )
            )
            .mappings()
            .one()
        )

        edit_miss_top_models_sql = text(
            """
            WITH request_hits AS (
              SELECT DISTINCT request_id
              FROM yarn_session_events
              WHERE event_kind = 'client_tool_error_observed'
                AND created_at >= :cutoff
                AND (:uid = '' OR user_id = :uid)
                AND (:oid = '' OR org_id = :oid)
                AND COALESCE(metadata_json->>'reason', '') = 'edit_context_miss'
                AND COALESCE(request_id, '') <> ''
            )
            SELECT
              COALESCE(NULLIF(u.provider, ''), 'unknown') AS provider,
              COALESCE(NULLIF(u.model, ''), 'unknown') AS model,
              COUNT(*)::int AS requests,
              COALESCE(SUM(COALESCE(u.tokens_in, 0) + COALESCE(u.tokens_out, 0)), 0)::bigint AS total_tokens,
              COALESCE(SUM(COALESCE(u.tokens_cached, 0)), 0)::bigint AS cached_tokens,
              COALESCE(
                SUM(
                  CASE
                    WHEN COALESCE(u.actual_cost_usd, 0) > 0 THEN COALESCE(u.actual_cost_usd, 0)
                    ELSE COALESCE(u.estimated_cost_usd, 0)
                  END
                ),
                0
              )::float AS effective_cost_usd
            FROM yarn_usage_log u
            JOIN request_hits rh ON rh.request_id = u.request_id
            GROUP BY provider, model
            ORDER BY requests DESC, total_tokens DESC
            LIMIT 8
            """
        )
        edit_miss_top_models_rows = (
            (
                await session.execute(
                    edit_miss_top_models_sql,
                    {
                        "cutoff": cutoff,
                        "uid": scope_user_id or "",
                        "oid": scope_org_id or "",
                    },
                )
            )
            .mappings()
            .all()
        )

        edit_miss_top_files_sql = text(
            """
            SELECT
              COALESCE(NULLIF(metadata_json->>'filePath', ''), '<unknown>') AS file_path,
              COUNT(*)::int AS miss_count
            FROM yarn_session_events
            WHERE event_kind = 'client_tool_error_observed'
              AND created_at >= :cutoff
              AND (:uid = '' OR user_id = :uid)
              AND (:oid = '' OR org_id = :oid)
              AND COALESCE(metadata_json->>'reason', '') = 'edit_context_miss'
            GROUP BY file_path
            ORDER BY miss_count DESC, file_path ASC
            LIMIT 8
            """
        )
        edit_miss_top_files_rows = (
            (
                await session.execute(
                    edit_miss_top_files_sql,
                    {
                        "cutoff": cutoff,
                        "uid": scope_user_id or "",
                        "oid": scope_org_id or "",
                    },
                )
            )
            .mappings()
            .all()
        )

        trajectory_sql = text(
            """
            SELECT
              COUNT(*)::int AS trajectory_events,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE((metadata_json->'verification'->>'first_pass_verify_ok')::boolean, false)
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS first_pass_verify_rate,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE((metadata_json->'verification'->>'stalled')::boolean, false)
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS verification_stall_rate,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE((metadata_json->'tools'->>'blind_retry_count')::int, 0) > 0
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS blind_retry_rate,
              COALESCE(SUM(COALESCE((metadata_json->'edits'->>'patch_ops_count')::int, 0)), 0)::int AS patch_ops,
              COALESCE(SUM(COALESCE((metadata_json->'edits'->>'whole_write_ops_count')::int, 0)), 0)::int AS whole_write_ops,
              COALESCE(AVG(COALESCE((metadata_json->'verification'->>'structured_error_coverage')::float, 0)), 0)::float AS structured_error_coverage,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE((metadata_json->'verification'->>'completion_gate_blocked')::boolean, false)
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS completion_gate_blocked_rate,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE((metadata_json->'verification'->>'critic_blocked')::boolean, false)
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS critic_block_rate
            FROM yarn_session_events
            WHERE event_kind = 'request_trajectory_v1'
              AND created_at >= :cutoff
              AND (:uid = '' OR user_id = :uid)
              AND (:oid = '' OR org_id = :oid)
            """
        )
        trajectory_row = (
            (
                await session.execute(
                    trajectory_sql,
                    {
                        "cutoff": cutoff,
                        "uid": scope_user_id or "",
                        "oid": scope_org_id or "",
                    },
                )
            )
            .mappings()
            .one()
        )

        bucket_sql = text(
            """
            SELECT
              COALESCE(metadata_json->>'task_bucket', 'unknown') AS bucket,
              COUNT(*)::int AS count
            FROM yarn_session_events
            WHERE event_kind = 'request_trajectory_v1'
              AND created_at >= :cutoff
              AND (:uid = '' OR user_id = :uid)
              AND (:oid = '' OR org_id = :oid)
            GROUP BY bucket
            ORDER BY count DESC
            """
        )
        bucket_rows = (
            (
                await session.execute(
                    bucket_sql,
                    {
                        "cutoff": cutoff,
                        "uid": scope_user_id or "",
                        "oid": scope_org_id or "",
                    },
                )
            )
            .mappings()
            .all()
        )
        trajectory_bucket_counts = {str(r["bucket"]): int(r["count"]) for r in bucket_rows}

        transition_quality_sql = text(
            """
            SELECT
              COUNT(*)::int AS trajectory_events,
              COALESCE(
                AVG(
                  NULLIF(
                    COALESCE(metadata_json->'training_signals'->>'state_transition_quality_score', ''),
                    ''
                  )::float
                ),
                0
              )::float AS quality_score_avg,
              COALESCE(
                SUM(
                  CASE
                    WHEN NULLIF(
                      COALESCE(metadata_json->'training_signals'->>'state_transition_quality_score', ''),
                      ''
                    ) IS NOT NULL
                    THEN 1 ELSE 0
                  END
                ),
                0
              )::int AS quality_score_observed_events,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE(metadata_json->'training_signals'->>'state_transition_quality_label', '') = 'forward_progress'
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS forward_progress_rate,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE(metadata_json->'training_signals'->>'state_transition_quality_label', '') = 'stalled'
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS stalled_rate,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE(metadata_json->'training_signals'->>'state_transition_quality_label', '') = 'regressed'
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS regressed_rate,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE(metadata_json->'training_signals'->>'state_transition_quality_label', '') = 'reground_required'
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS reground_required_rate,
              COALESCE(
                SUM(
                  CASE
                    WHEN COALESCE(metadata_json->'training_signals'->>'state_transition_quality_label', '') = 'forward_progress'
                    THEN 1 ELSE 0
                  END
                ),
                0
              )::int AS forward_progress_count,
              COALESCE(
                SUM(
                  CASE
                    WHEN COALESCE(metadata_json->'training_signals'->>'state_transition_quality_label', '') = 'stalled'
                    THEN 1 ELSE 0
                  END
                ),
                0
              )::int AS stalled_count,
              COALESCE(
                SUM(
                  CASE
                    WHEN COALESCE(metadata_json->'training_signals'->>'state_transition_quality_label', '') = 'regressed'
                    THEN 1 ELSE 0
                  END
                ),
                0
              )::int AS regressed_count,
              COALESCE(
                SUM(
                  CASE
                    WHEN COALESCE(metadata_json->'training_signals'->>'state_transition_quality_label', '') = 'reground_required'
                    THEN 1 ELSE 0
                  END
                ),
                0
              )::int AS reground_required_count,
              COALESCE(
                AVG(
                  NULLIF(
                    COALESCE(metadata_json->'training_signals'->>'state_transition_quality_forward_min', ''),
                    ''
                  )::float
                ),
                0
              )::float AS quality_forward_min_avg,
              COALESCE(
                AVG(
                  NULLIF(
                    COALESCE(metadata_json->'training_signals'->>'state_transition_quality_regressed_max', ''),
                    ''
                  )::float
                ),
                0
              )::float AS quality_regressed_max_avg
            FROM yarn_session_events
            WHERE event_kind = 'request_trajectory_v1'
              AND created_at >= :cutoff
              AND (:uid = '' OR user_id = :uid)
              AND (:oid = '' OR org_id = :oid)
            """
        )
        transition_quality_row = (
            (
                await session.execute(
                    transition_quality_sql,
                    {
                        "cutoff": cutoff,
                        "uid": scope_user_id or "",
                        "oid": scope_org_id or "",
                    },
                )
            )
            .mappings()
            .one()
        )

        scope_counts_sql = text(
            """
            SELECT
              COALESCE(
                NULLIF(metadata_json->'training_signals'->>'state_transition_quality_global_scope', ''),
                'none'
              ) AS scope,
              COUNT(*)::int AS count
            FROM yarn_session_events
            WHERE event_kind = 'request_trajectory_v1'
              AND created_at >= :cutoff
              AND (:uid = '' OR user_id = :uid)
              AND (:oid = '' OR org_id = :oid)
            GROUP BY scope
            ORDER BY count DESC
            """
        )
        scope_counts_rows = (
            (
                await session.execute(
                    scope_counts_sql,
                    {
                        "cutoff": cutoff,
                        "uid": scope_user_id or "",
                        "oid": scope_org_id or "",
                    },
                )
            )
            .mappings()
            .all()
        )
        quality_global_scope_counts = {str(r["scope"]): int(r["count"]) for r in scope_counts_rows}

        quality_reasons_sql = text(
            """
            WITH scoped AS (
              SELECT
                CASE
                  WHEN jsonb_typeof(metadata_json->'training_signals'->'state_transition_quality_reasons') = 'array'
                  THEN metadata_json->'training_signals'->'state_transition_quality_reasons'
                  ELSE '[]'::jsonb
                END AS reasons
              FROM yarn_session_events
              WHERE event_kind = 'request_trajectory_v1'
                AND created_at >= :cutoff
                AND (:uid = '' OR user_id = :uid)
                AND (:oid = '' OR org_id = :oid)
            )
            SELECT reason, COUNT(*)::int AS count
            FROM (
              SELECT jsonb_array_elements_text(reasons) AS reason
              FROM scoped
            ) expanded
            WHERE NULLIF(BTRIM(reason), '') IS NOT NULL
            GROUP BY reason
            ORDER BY count DESC, reason ASC
            LIMIT 8
            """
        )
        quality_reason_rows = (
            (
                await session.execute(
                    quality_reasons_sql,
                    {
                        "cutoff": cutoff,
                        "uid": scope_user_id or "",
                        "oid": scope_org_id or "",
                    },
                )
            )
            .mappings()
            .all()
        )

        quality_calibration_sql = text(
            """
            SELECT
              COALESCE(
                SUM(CASE WHEN event_kind = 'state_transition_quality_calibration_v1' THEN 1 ELSE 0 END),
                0
              )::int AS local_calibration_events,
              COALESCE(
                SUM(CASE WHEN event_kind = 'state_transition_quality_global_calibration_v1' THEN 1 ELSE 0 END),
                0
              )::int AS global_calibration_events,
              MAX(CASE WHEN event_kind = 'state_transition_quality_calibration_v1' THEN created_at END) AS latest_local_calibration_at,
              MAX(CASE WHEN event_kind = 'state_transition_quality_global_calibration_v1' THEN created_at END) AS latest_global_calibration_at
            FROM yarn_session_events
            WHERE event_kind IN (
              'state_transition_quality_calibration_v1',
              'state_transition_quality_global_calibration_v1'
            )
              AND created_at >= :cutoff
              AND (:uid = '' OR user_id = :uid)
              AND (:oid = '' OR org_id = :oid)
            """
        )
        quality_calibration_row = (
            (
                await session.execute(
                    quality_calibration_sql,
                    {
                        "cutoff": cutoff,
                        "uid": scope_user_id or "",
                        "oid": scope_org_id or "",
                    },
                )
            )
            .mappings()
            .one()
        )

    requests = int(row.requests or 0)
    total_tokens = int(row.total_tokens or 0)
    cached_tokens = int(row.cached_tokens or 0)
    cache_hit_estimate = (cached_tokens / total_tokens) if total_tokens else 0.0
    edit_miss_events = int(edit_miss_rollup_row["miss_events"] or 0)
    edit_miss_impacted_requests = int(edit_miss_rollup_row["impacted_requests"] or 0)
    edit_miss_mapped_requests = int(edit_miss_rollup_row["mapped_requests"] or 0)
    edit_miss_impacted_sessions = int(edit_miss_rollup_row["impacted_sessions"] or 0)
    edit_miss_impacted_tokens = int(edit_miss_rollup_row["impacted_tokens"] or 0)
    edit_miss_impacted_cached_tokens = int(edit_miss_rollup_row["impacted_cached_tokens"] or 0)
    edit_miss_impacted_cost_usd = float(edit_miss_rollup_row["impacted_cost_usd"] or 0.0)
    edit_miss_event_rate = (edit_miss_events / requests) if requests else 0.0
    edit_miss_request_rate = (edit_miss_impacted_requests / requests) if requests else 0.0
    edit_miss_mapping_coverage = (
        edit_miss_mapped_requests / edit_miss_impacted_requests if edit_miss_impacted_requests else 0.0
    )
    edit_miss_cache_hit_estimate = (
        edit_miss_impacted_cached_tokens / edit_miss_impacted_tokens if edit_miss_impacted_tokens else 0.0
    )
    patch_ops = int(trajectory_row["patch_ops"] or 0)
    whole_write_ops = int(trajectory_row["whole_write_ops"] or 0)
    patch_ratio = (patch_ops / (patch_ops + whole_write_ops)) if (patch_ops + whole_write_ops) > 0 else 0.0
    quality_trajectory_events = int(transition_quality_row["trajectory_events"] or 0)
    quality_score_avg = float(transition_quality_row["quality_score_avg"] or 0.0)
    quality_score_observed_events = int(transition_quality_row["quality_score_observed_events"] or 0)
    quality_score_coverage = (
        quality_score_observed_events / quality_trajectory_events if quality_trajectory_events else 0.0
    )
    forward_progress_rate = float(transition_quality_row["forward_progress_rate"] or 0.0)
    stalled_rate = float(transition_quality_row["stalled_rate"] or 0.0)
    regressed_rate = float(transition_quality_row["regressed_rate"] or 0.0)
    reground_required_rate = float(transition_quality_row["reground_required_rate"] or 0.0)
    quality_forward_min_avg = float(transition_quality_row["quality_forward_min_avg"] or 0.0)
    quality_regressed_max_avg = float(transition_quality_row["quality_regressed_max_avg"] or 0.0)
    quality_local_calibration_events = int(quality_calibration_row["local_calibration_events"] or 0)
    quality_global_calibration_events = int(quality_calibration_row["global_calibration_events"] or 0)
    quality_latest_local_calibration_at = quality_calibration_row["latest_local_calibration_at"]
    quality_latest_global_calibration_at = quality_calibration_row["latest_global_calibration_at"]
    quality_scope_none_count = int(quality_global_scope_counts.get("none", 0))
    quality_global_scope_coverage = (
        1.0 - (quality_scope_none_count / quality_trajectory_events) if quality_trajectory_events else 0.0
    )
    quality_score_coverage_warn_threshold = 0.6
    quality_risk_flags: list[str] = []
    if regressed_rate >= 0.15:
        quality_risk_flags.append("high_regressed_rate")
    if reground_required_rate >= 0.08:
        quality_risk_flags.append("high_reground_required_rate")
    if quality_trajectory_events >= 20 and forward_progress_rate < 0.45:
        quality_risk_flags.append("low_forward_progress_rate")
    if quality_trajectory_events >= 20 and quality_global_scope_coverage < 0.5:
        quality_risk_flags.append("low_global_scope_coverage")
    if quality_trajectory_events >= 20 and quality_score_coverage < quality_score_coverage_warn_threshold:
        quality_risk_flags.append("low_quality_score_coverage")
    if quality_trajectory_events >= 30 and quality_global_calibration_events == 0:
        quality_risk_flags.append("missing_global_calibration_events")
    if quality_trajectory_events >= 30 and quality_local_calibration_events == 0:
        quality_risk_flags.append("missing_local_calibration_events")
    if quality_trajectory_events >= 20 and quality_score_avg < 0:
        quality_risk_flags.append("negative_quality_score")

    return {
        "since_hours": since_hours,
        "requests": requests,
        "avg_tool_calls_per_request": round(float(row.avg_tool_calls or 0), 2),
        "cache_hit_estimate": round(cache_hit_estimate, 4),
        "tool_use_stop_rate": round((int(row.tool_use_stops or 0) / requests), 4) if requests else 0.0,
        "error_like_rate": round((int(row.error_like or 0) / requests), 4) if requests else 0.0,
        "trajectory_events": int(trajectory_row["trajectory_events"] or 0),
        "first_pass_verify_rate": round(float(trajectory_row["first_pass_verify_rate"] or 0), 4),
        "verification_stall_rate": round(float(trajectory_row["verification_stall_rate"] or 0), 4),
        "blind_retry_rate": round(float(trajectory_row["blind_retry_rate"] or 0), 4),
        "patch_ratio": round(patch_ratio, 4),
        "structured_error_coverage": round(float(trajectory_row["structured_error_coverage"] or 0), 4),
        "completion_gate_blocked_rate": round(float(trajectory_row["completion_gate_blocked_rate"] or 0), 4),
        "critic_block_rate": round(float(trajectory_row["critic_block_rate"] or 0), 4),
        "trajectory_bucket_counts": trajectory_bucket_counts,
        "state_transition_quality": {
            "trajectory_events": quality_trajectory_events,
            "score_avg": round(quality_score_avg, 4),
            "score_observed_events": quality_score_observed_events,
            "score_coverage": round(quality_score_coverage, 4),
            "label_rates": {
                "forward_progress": round(forward_progress_rate, 4),
                "stalled": round(stalled_rate, 4),
                "regressed": round(regressed_rate, 4),
                "reground_required": round(reground_required_rate, 4),
            },
            "label_counts": {
                "forward_progress": int(transition_quality_row["forward_progress_count"] or 0),
                "stalled": int(transition_quality_row["stalled_count"] or 0),
                "regressed": int(transition_quality_row["regressed_count"] or 0),
                "reground_required": int(transition_quality_row["reground_required_count"] or 0),
            },
            "threshold_band_avg": {
                "forward_progress_min": round(quality_forward_min_avg, 4),
                "regressed_max": round(quality_regressed_max_avg, 4),
            },
            "global_scope_counts": quality_global_scope_counts,
            "global_scope_coverage": round(quality_global_scope_coverage, 4),
            "calibration_events": {
                "local": quality_local_calibration_events,
                "global": quality_global_calibration_events,
                "latest_local_at": quality_latest_local_calibration_at.isoformat()
                if quality_latest_local_calibration_at
                else None,
                "latest_global_at": quality_latest_global_calibration_at.isoformat()
                if quality_latest_global_calibration_at
                else None,
            },
            "top_reasons": [{"reason": str(r["reason"]), "count": int(r["count"] or 0)} for r in quality_reason_rows],
            "risk_flags": quality_risk_flags,
        },
        "top_models": top_models,
        "finish_reason_counts": finish_reason_counts,
        "edit_context_miss": {
            "events": edit_miss_events,
            "event_rate": round(edit_miss_event_rate, 4),
            "impacted_requests": edit_miss_impacted_requests,
            "request_rate": round(edit_miss_request_rate, 4),
            "mapped_requests": edit_miss_mapped_requests,
            "mapping_coverage": round(edit_miss_mapping_coverage, 4),
            "unmapped_requests": max(edit_miss_impacted_requests - edit_miss_mapped_requests, 0),
            "impacted_sessions": edit_miss_impacted_sessions,
            "impacted_tokens": edit_miss_impacted_tokens,
            "impacted_cached_tokens": edit_miss_impacted_cached_tokens,
            "impacted_cache_hit_estimate": round(edit_miss_cache_hit_estimate, 4),
            "impacted_cost_usd": round(edit_miss_impacted_cost_usd, 4),
            "top_models": [
                {
                    "provider": str(r["provider"] or "unknown"),
                    "model": str(r["model"] or "unknown"),
                    "requests": int(r["requests"] or 0),
                    "total_tokens": int(r["total_tokens"] or 0),
                    "cached_tokens": int(r["cached_tokens"] or 0),
                    "effective_cost_usd": round(float(r["effective_cost_usd"] or 0), 4),
                }
                for r in edit_miss_top_models_rows
            ],
            "top_files": [
                {
                    "file_path": str(r["file_path"] or "<unknown>"),
                    "miss_count": int(r["miss_count"] or 0),
                }
                for r in edit_miss_top_files_rows
            ],
        },
    }


# ── Transition quality telemetry ──────────────────────────────────────────────


async def get_yarn_transition_quality_series(
    since_hours: int = 168,
    bucket_minutes: int = 60,
    scope_user_id: str = "",
    scope_org_id: str = "",
) -> dict:
    cutoff = _cutoff(since_hours)
    regressed_warn_threshold = 0.15
    reground_warn_threshold = 0.08
    global_scope_warn_threshold = 0.5
    quality_score_warn_threshold = 0.0
    quality_score_coverage_warn_threshold = 0.6

    async with async_session() as session:
        trajectory_sql = text(
            """
            SELECT
              date_trunc('hour', created_at) +
                (EXTRACT(minute FROM created_at)::int / :bucket * :bucket) * interval '1 minute'
                AS bucket,
              COUNT(*)::int AS trajectory_events,
              COALESCE(
                AVG(
                  NULLIF(
                    COALESCE(metadata_json->'training_signals'->>'state_transition_quality_score', ''),
                    ''
                  )::float
                ),
                0
              )::float AS quality_score_avg,
              COALESCE(
                SUM(
                  CASE
                    WHEN NULLIF(
                      COALESCE(metadata_json->'training_signals'->>'state_transition_quality_score', ''),
                      ''
                    ) IS NOT NULL
                    THEN 1 ELSE 0
                  END
                ),
                0
              )::int AS quality_score_observed_events,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE(metadata_json->'training_signals'->>'state_transition_quality_label', '') = 'forward_progress'
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS forward_progress_rate,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE(metadata_json->'training_signals'->>'state_transition_quality_label', '') = 'stalled'
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS stalled_rate,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE(metadata_json->'training_signals'->>'state_transition_quality_label', '') = 'regressed'
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS regressed_rate,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE(metadata_json->'training_signals'->>'state_transition_quality_label', '') = 'reground_required'
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS reground_required_rate,
              COALESCE(
                AVG(
                  CASE
                    WHEN COALESCE(
                      NULLIF(metadata_json->'training_signals'->>'state_transition_quality_global_scope', ''),
                      'none'
                    ) <> 'none'
                    THEN 1.0 ELSE 0.0
                  END
                ),
                0
              )::float AS global_scope_coverage,
              COALESCE(
                AVG(
                  NULLIF(
                    COALESCE(metadata_json->'training_signals'->>'state_transition_quality_forward_min', ''),
                    ''
                  )::float
                ),
                0
              )::float AS quality_forward_min_avg,
              COALESCE(
                AVG(
                  NULLIF(
                    COALESCE(metadata_json->'training_signals'->>'state_transition_quality_regressed_max', ''),
                    ''
                  )::float
                ),
                0
              )::float AS quality_regressed_max_avg
            FROM yarn_session_events
            WHERE event_kind = 'request_trajectory_v1'
              AND created_at >= :cutoff
              AND (:uid = '' OR user_id = :uid)
              AND (:oid = '' OR org_id = :oid)
            GROUP BY bucket
            ORDER BY bucket
            """
        )
        trajectory_rows = (
            (
                await session.execute(
                    trajectory_sql,
                    {
                        "bucket": bucket_minutes,
                        "cutoff": cutoff,
                        "uid": scope_user_id or "",
                        "oid": scope_org_id or "",
                    },
                )
            )
            .mappings()
            .all()
        )

        calibration_sql = text(
            """
            SELECT
              date_trunc('hour', created_at) +
                (EXTRACT(minute FROM created_at)::int / :bucket * :bucket) * interval '1 minute'
                AS bucket,
              COALESCE(
                SUM(CASE WHEN event_kind = 'state_transition_quality_calibration_v1' THEN 1 ELSE 0 END),
                0
              )::int AS local_calibration_events,
              COALESCE(
                SUM(CASE WHEN event_kind = 'state_transition_quality_global_calibration_v1' THEN 1 ELSE 0 END),
                0
              )::int AS global_calibration_events
            FROM yarn_session_events
            WHERE event_kind IN (
              'state_transition_quality_calibration_v1',
              'state_transition_quality_global_calibration_v1'
            )
              AND created_at >= :cutoff
              AND (:uid = '' OR user_id = :uid)
              AND (:oid = '' OR org_id = :oid)
            GROUP BY bucket
            ORDER BY bucket
            """
        )
        calibration_rows = (
            (
                await session.execute(
                    calibration_sql,
                    {
                        "bucket": bucket_minutes,
                        "cutoff": cutoff,
                        "uid": scope_user_id or "",
                        "oid": scope_org_id or "",
                    },
                )
            )
            .mappings()
            .all()
        )

        reason_sql = text(
            """
            WITH scoped AS (
              SELECT
                CASE
                  WHEN jsonb_typeof(metadata_json->'training_signals'->'state_transition_quality_reasons') = 'array'
                  THEN metadata_json->'training_signals'->'state_transition_quality_reasons'
                  ELSE '[]'::jsonb
                END AS reasons
              FROM yarn_session_events
              WHERE event_kind = 'request_trajectory_v1'
                AND created_at >= :cutoff
                AND (:uid = '' OR user_id = :uid)
                AND (:oid = '' OR org_id = :oid)
            )
            SELECT reason, COUNT(*)::int AS count
            FROM (
              SELECT jsonb_array_elements_text(reasons) AS reason
              FROM scoped
            ) expanded
            WHERE NULLIF(BTRIM(reason), '') IS NOT NULL
            GROUP BY reason
            ORDER BY count DESC, reason ASC
            LIMIT 10
            """
        )
        reason_rows = (
            (
                await session.execute(
                    reason_sql,
                    {
                        "cutoff": cutoff,
                        "uid": scope_user_id or "",
                        "oid": scope_org_id or "",
                    },
                )
            )
            .mappings()
            .all()
        )

    calibration_by_bucket = {
        r["bucket"]: {
            "local_calibration_events": int(r["local_calibration_events"] or 0),
            "global_calibration_events": int(r["global_calibration_events"] or 0),
        }
        for r in calibration_rows
    }

    buckets: list[dict] = []
    weighted_quality_sum = 0.0
    weighted_regressed_sum = 0.0
    weighted_reground_sum = 0.0
    weighted_scope_coverage_sum = 0.0
    weighted_forward_min_sum = 0.0
    weighted_regressed_max_sum = 0.0
    trajectory_events_total = 0
    quality_score_observed_events_total = 0
    local_calibration_events_total = 0
    global_calibration_events_total = 0

    for row in trajectory_rows:
        bucket = row["bucket"]
        trajectory_events = int(row["trajectory_events"] or 0)
        quality_score_avg = float(row["quality_score_avg"] or 0.0)
        quality_score_observed_events = int(row["quality_score_observed_events"] or 0)
        quality_score_coverage = quality_score_observed_events / trajectory_events if trajectory_events else 0.0
        forward_progress_rate = float(row["forward_progress_rate"] or 0.0)
        stalled_rate = float(row["stalled_rate"] or 0.0)
        regressed_rate = float(row["regressed_rate"] or 0.0)
        reground_required_rate = float(row["reground_required_rate"] or 0.0)
        global_scope_coverage = float(row["global_scope_coverage"] or 0.0)
        quality_forward_min_avg = float(row["quality_forward_min_avg"] or 0.0)
        quality_regressed_max_avg = float(row["quality_regressed_max_avg"] or 0.0)
        calibration = calibration_by_bucket.get(
            bucket,
            {
                "local_calibration_events": 0,
                "global_calibration_events": 0,
            },
        )
        local_calibration_events = int(calibration["local_calibration_events"])
        global_calibration_events = int(calibration["global_calibration_events"])

        risk_flags: list[str] = []
        if regressed_rate >= regressed_warn_threshold:
            risk_flags.append("high_regressed_rate")
        if reground_required_rate >= reground_warn_threshold:
            risk_flags.append("high_reground_required_rate")
        if global_scope_coverage < global_scope_warn_threshold and trajectory_events >= 5:
            risk_flags.append("low_global_scope_coverage")
        if quality_score_coverage < quality_score_coverage_warn_threshold and trajectory_events >= 5:
            risk_flags.append("low_quality_score_coverage")
        if quality_score_avg < quality_score_warn_threshold and trajectory_events >= 5:
            risk_flags.append("negative_quality_score")
        if (local_calibration_events + global_calibration_events) == 0 and trajectory_events >= 10:
            risk_flags.append("no_calibration_events")

        buckets.append(
            {
                "bucket": bucket.isoformat() if bucket else None,
                "trajectory_events": trajectory_events,
                "quality_score_avg": round(quality_score_avg, 4),
                "quality_score_observed_events": quality_score_observed_events,
                "quality_score_coverage": round(quality_score_coverage, 4),
                "forward_progress_rate": round(forward_progress_rate, 4),
                "stalled_rate": round(stalled_rate, 4),
                "regressed_rate": round(regressed_rate, 4),
                "reground_required_rate": round(reground_required_rate, 4),
                "global_scope_coverage": round(global_scope_coverage, 4),
                "quality_forward_min_avg": round(quality_forward_min_avg, 4),
                "quality_regressed_max_avg": round(quality_regressed_max_avg, 4),
                "local_calibration_events": local_calibration_events,
                "global_calibration_events": global_calibration_events,
                "risk_flags": risk_flags,
            }
        )

        trajectory_events_total += trajectory_events
        quality_score_observed_events_total += quality_score_observed_events
        local_calibration_events_total += local_calibration_events
        global_calibration_events_total += global_calibration_events
        weighted_quality_sum += quality_score_avg * trajectory_events
        weighted_regressed_sum += regressed_rate * trajectory_events
        weighted_reground_sum += reground_required_rate * trajectory_events
        weighted_scope_coverage_sum += global_scope_coverage * trajectory_events
        weighted_forward_min_sum += quality_forward_min_avg * trajectory_events
        weighted_regressed_max_sum += quality_regressed_max_avg * trajectory_events

    alert_buckets = [bucket for bucket in buckets if bucket["risk_flags"]]

    quality_score_avg_window = weighted_quality_sum / trajectory_events_total if trajectory_events_total else 0.0
    regressed_rate_avg_window = weighted_regressed_sum / trajectory_events_total if trajectory_events_total else 0.0
    reground_rate_avg_window = weighted_reground_sum / trajectory_events_total if trajectory_events_total else 0.0
    global_scope_coverage_avg_window = (
        weighted_scope_coverage_sum / trajectory_events_total if trajectory_events_total else 0.0
    )
    quality_score_coverage_avg_window = (
        quality_score_observed_events_total / trajectory_events_total if trajectory_events_total else 0.0
    )
    quality_forward_min_avg_window = (
        weighted_forward_min_sum / trajectory_events_total if trajectory_events_total else 0.0
    )
    quality_regressed_max_avg_window = (
        weighted_regressed_max_sum / trajectory_events_total if trajectory_events_total else 0.0
    )

    risk_flags_window: list[str] = []
    if regressed_rate_avg_window >= regressed_warn_threshold:
        risk_flags_window.append("high_regressed_rate")
    if reground_rate_avg_window >= reground_warn_threshold:
        risk_flags_window.append("high_reground_required_rate")
    if trajectory_events_total >= 20 and global_scope_coverage_avg_window < global_scope_warn_threshold:
        risk_flags_window.append("low_global_scope_coverage")
    if trajectory_events_total >= 20 and quality_score_coverage_avg_window < quality_score_coverage_warn_threshold:
        risk_flags_window.append("low_quality_score_coverage")
    if trajectory_events_total >= 20 and quality_score_avg_window < quality_score_warn_threshold:
        risk_flags_window.append("negative_quality_score")
    if trajectory_events_total >= 20 and global_calibration_events_total == 0:
        risk_flags_window.append("missing_global_calibration_events")

    actions: list[str] = []
    if "high_regressed_rate" in risk_flags_window:
        actions.append("Prioritize regressed trajectories in event drilldown and validate recovery prompt quality.")
    if "high_reground_required_rate" in risk_flags_window:
        actions.append("Investigate stale/partial file state pressure and tune re-ground policies.")
    if "low_global_scope_coverage" in risk_flags_window:
        actions.append("Check org/model scope key stability and verify global calibrator persistence is healthy.")
    if "low_quality_score_coverage" in risk_flags_window:
        actions.append(
            "Check request_trajectory_v1 training_signals emission and recover state_transition_quality_score coverage."
        )
    if "missing_global_calibration_events" in risk_flags_window:
        actions.append("Verify state_transition_quality_global_calibration_v1 events and shared store writes.")
    if "negative_quality_score" in risk_flags_window:
        actions.append("Hold threshold tightening until average quality score returns above zero.")
    if not actions:
        actions.append("Transition quality telemetry is stable. Continue monitoring drift and top quality reasons.")

    return {
        "since_hours": since_hours,
        "bucket_minutes": bucket_minutes,
        "summary": {
            "bucket_count": len(buckets),
            "trajectory_events_total": trajectory_events_total,
            "quality_score_avg": round(quality_score_avg_window, 4),
            "quality_score_observed_events_total": quality_score_observed_events_total,
            "quality_score_coverage_avg": round(quality_score_coverage_avg_window, 4),
            "regressed_rate_avg": round(regressed_rate_avg_window, 4),
            "reground_required_rate_avg": round(reground_rate_avg_window, 4),
            "global_scope_coverage_avg": round(global_scope_coverage_avg_window, 4),
            "quality_forward_min_avg": round(quality_forward_min_avg_window, 4),
            "quality_regressed_max_avg": round(quality_regressed_max_avg_window, 4),
            "local_calibration_events_total": local_calibration_events_total,
            "global_calibration_events_total": global_calibration_events_total,
            "risk_flags": risk_flags_window,
        },
        "alert_thresholds": {
            "regressed_rate_warn": regressed_warn_threshold,
            "reground_required_rate_warn": reground_warn_threshold,
            "global_scope_coverage_warn": global_scope_warn_threshold,
            "quality_score_warn": quality_score_warn_threshold,
            "quality_score_coverage_warn": quality_score_coverage_warn_threshold,
        },
        "top_quality_reasons": [{"reason": str(r["reason"]), "count": int(r["count"] or 0)} for r in reason_rows],
        "alert_buckets": alert_buckets[:24],
        "actions": actions,
        "buckets": buckets,
    }


# ── Transition event tail ─────────────────────────────────────────────────────

_TRANSITION_EVENT_KINDS = {
    "request_trajectory_v1",
    "state_transition_v1",
    "state_transition_quality_calibration_v1",
    "state_transition_quality_global_calibration_v1",
}
_TRANSITION_RISK_LABELS = {"regressed", "reground_required"}


def _coerce_transition_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _coerce_transition_float(value: object) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_transition_str_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        text = str(item or "").strip()
        if text:
            out.append(text)
    return out


def _extract_transition_event_view(event_kind: str, metadata_json: object) -> dict:
    metadata = metadata_json if isinstance(metadata_json, dict) else {}
    training = metadata.get("training_signals")
    quality = metadata.get("quality")

    training_dict = training if isinstance(training, dict) else {}
    quality_dict = quality if isinstance(quality, dict) else {}

    label = str(training_dict.get("state_transition_quality_label") or "").strip().lower()
    if not label:
        label = str(quality_dict.get("label") or "").strip().lower()

    score = _coerce_transition_float(training_dict.get("state_transition_quality_score"))
    if score is None:
        score = _coerce_transition_float(quality_dict.get("score"))

    global_scope = str(training_dict.get("state_transition_quality_global_scope") or "").strip() or None
    reasons = _coerce_transition_str_list(training_dict.get("state_transition_quality_reasons"))
    if not reasons:
        reasons = _coerce_transition_str_list(quality_dict.get("reasons"))

    risk_flags = _coerce_transition_str_list(training_dict.get("state_transition_quality_risk_flags"))
    if score is not None and score < 0 and "negative_quality_score" not in risk_flags:
        risk_flags.append("negative_quality_score")
    if label in _TRANSITION_RISK_LABELS:
        flag = f"quality_label_{label}"
        if flag not in risk_flags:
            risk_flags.append(flag)
    if event_kind == "state_transition_quality_global_calibration_v1":
        if "global_calibration" not in risk_flags:
            risk_flags.append("global_calibration")
    if event_kind == "state_transition_quality_calibration_v1":
        if "local_calibration" not in risk_flags:
            risk_flags.append("local_calibration")

    calibration_samples = _coerce_transition_int(
        training_dict.get("state_transition_quality_calibration_sample_count"), 0
    )
    if calibration_samples <= 0 and event_kind.endswith("calibration_v1"):
        calibration_meta = metadata.get("calibration")
        if isinstance(calibration_meta, dict):
            calibration_samples = _coerce_transition_int(calibration_meta.get("sample_count"), 0)

    return {
        "quality_label": label or None,
        "quality_score": score,
        "global_scope": global_scope,
        "reasons": reasons,
        "risk_flags": risk_flags,
        "calibration_sample_count": calibration_samples if calibration_samples > 0 else None,
    }


async def get_yarn_transition_events(
    since_minutes: int = 60,
    limit: int = 100,
    after_id: int = 0,
    scope_user_id: str = "",
    scope_org_id: str = "",
    risk_only: bool = True,
    include_metadata: bool = False,
    event_kinds: list[str] | None = None,
) -> dict:
    cutoff = datetime.now(UTC) - timedelta(minutes=since_minutes)
    requested_event_kinds = [str(kind).strip() for kind in (event_kinds or []) if str(kind).strip()]
    selected_event_kinds = requested_event_kinds or sorted(_TRANSITION_EVENT_KINDS)

    async with async_session() as session:
        base = select(YarnSessionEvent).where(YarnSessionEvent.created_at >= cutoff)
        if scope_user_id:
            base = base.where(YarnSessionEvent.user_id == scope_user_id)
        elif scope_org_id:
            base = base.where(YarnSessionEvent.org_id == scope_org_id)
        if after_id > 0:
            base = base.where(YarnSessionEvent.id > after_id)
        if selected_event_kinds:
            base = base.where(YarnSessionEvent.event_kind.in_(selected_event_kinds))

        rows = (await session.execute(base.order_by(YarnSessionEvent.id.desc()).limit(limit))).scalars().all()

    rows = list(reversed(rows))
    events: list[dict] = []
    counts_by_kind: dict[str, int] = {}
    next_after_id = after_id
    sessions: set[str] = set()
    requests: set[str] = set()

    for row in rows:
        event_view = _extract_transition_event_view(row.event_kind, row.metadata_json)
        risk_flags = list(event_view["risk_flags"])
        is_risk = bool(risk_flags)
        if risk_only and not is_risk:
            continue

        sessions.add(row.session_key)
        if row.request_id:
            requests.add(row.request_id)
        counts_by_kind[row.event_kind] = counts_by_kind.get(row.event_kind, 0) + 1
        next_after_id = max(next_after_id, int(row.id))

        item: dict = {
            "id": int(row.id),
            "session_key": row.session_key,
            "request_id": row.request_id,
            "event_kind": row.event_kind,
            "component": row.component,
            "detail": row.detail,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "quality_label": event_view["quality_label"],
            "quality_score": event_view["quality_score"],
            "global_scope": event_view["global_scope"],
            "reasons": event_view["reasons"],
            "risk_flags": risk_flags,
            "calibration_sample_count": event_view["calibration_sample_count"],
        }
        if include_metadata:
            item["metadata_json"] = row.metadata_json
        events.append(item)

    return {
        "since_minutes": since_minutes,
        "event_kinds": selected_event_kinds,
        "risk_only": risk_only,
        "include_metadata": include_metadata,
        "count": len(events),
        "session_count": len(sessions),
        "request_count": len(requests),
        "counts_by_kind": counts_by_kind,
        "next_after_id": next_after_id,
        "events": events,
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
            await session.execute(select(func.coalesce(func.sum(sub.c.tokens_burned), 0)).select_from(sub))
        ).scalar() or 0

    return {
        "since_hours": since_hours,
        "total_events": total,
        "by_kind": by_kind,
        "total_tokens_burned": int(total_tokens_burned),
    }


# ── Purge ─────────────────────────────────────────────────────────────────────


async def _select_session_keys(
    *,
    session_keys: list[str] | None = None,
    older_than_days: int | None = None,
    session_key_prefix: str = "",
) -> list[str]:
    cleaned_keys = [k.strip()[:256] for k in (session_keys or []) if k.strip()]
    if cleaned_keys:
        return list(dict.fromkeys(cleaned_keys))[:1000]

    if older_than_days is None:
        return []

    cutoff = datetime.now(UTC) - timedelta(days=older_than_days)
    async with async_session() as session:
        base = select(YarnSession.session_key).where(YarnSession.last_active_at < cutoff)
        if session_key_prefix:
            base = base.where(YarnSession.session_key.like(f"{session_key_prefix[:128]}%"))
        result = await session.execute(base.order_by(YarnSession.last_active_at.asc()).limit(10000))
    return [r[0] for r in result.all()]


async def _count_yarn_archive_rows(keys: list[str]) -> dict[str, int]:
    if not keys:
        return {"sessions": 0, "usage_rows": 0, "events": 0, "safety_events": 0}
    async with async_session() as session:
        sessions_count = (
            await session.execute(
                select(func.count()).select_from(
                    select(YarnSession).where(YarnSession.session_key.in_(keys)).subquery()
                )
            )
        ).scalar() or 0
        usage_count = (
            await session.execute(
                select(func.count()).select_from(
                    select(YarnUsageLog).where(YarnUsageLog.session_key.in_(keys)).subquery()
                )
            )
        ).scalar() or 0
        events_count = (
            await session.execute(
                select(func.count()).select_from(
                    select(YarnSessionEvent).where(YarnSessionEvent.session_key.in_(keys)).subquery()
                )
            )
        ).scalar() or 0
        safety_count = (
            await session.execute(
                select(func.count()).select_from(
                    select(YarnSafetyEvent).where(YarnSafetyEvent.session_key.in_(keys)).subquery()
                )
            )
        ).scalar() or 0
    return {
        "sessions": int(sessions_count),
        "usage_rows": int(usage_count),
        "events": int(events_count),
        "safety_events": int(safety_count),
    }


async def _archive_records_for_yarn(keys: list[str]) -> list[dict[str, Any]]:
    if not keys:
        return []
    records: list[dict[str, Any]] = []
    async with async_session() as session:
        session_rows = (
            (
                await session.execute(
                    select(YarnSession).where(YarnSession.session_key.in_(keys)).order_by(YarnSession.id)
                )
            )
            .scalars()
            .all()
        )
        usage_rows = (
            (
                await session.execute(
                    select(YarnUsageLog)
                    .where(YarnUsageLog.session_key.in_(keys))
                    .order_by(YarnUsageLog.created_at, YarnUsageLog.id)
                )
            )
            .scalars()
            .all()
        )
        event_rows = (
            (
                await session.execute(
                    select(YarnSessionEvent)
                    .where(YarnSessionEvent.session_key.in_(keys))
                    .order_by(YarnSessionEvent.created_at, YarnSessionEvent.id)
                )
            )
            .scalars()
            .all()
        )
        safety_rows = (
            (
                await session.execute(
                    select(YarnSafetyEvent)
                    .where(YarnSafetyEvent.session_key.in_(keys))
                    .order_by(YarnSafetyEvent.created_at, YarnSafetyEvent.id)
                )
            )
            .scalars()
            .all()
        )

    records.extend({"record_type": "yarn_session", "data": _row_dict(row)} for row in session_rows)
    records.extend({"record_type": "yarn_usage_log", "data": _row_dict(row)} for row in usage_rows)
    records.extend({"record_type": "yarn_session_event", "data": _row_dict(row)} for row in event_rows)
    records.extend({"record_type": "yarn_safety_event", "data": _row_dict(row)} for row in safety_rows)
    return records


async def _delete_yarn_keys(keys: list[str]) -> dict[str, int]:
    if not keys:
        return {"sessions": 0, "usage_rows": 0, "events": 0, "safety_events": 0}
    async with async_session() as session:
        events_result = await session.execute(
            YarnSessionEvent.__table__.delete().where(YarnSessionEvent.session_key.in_(keys))
        )
        usage_result = await session.execute(YarnUsageLog.__table__.delete().where(YarnUsageLog.session_key.in_(keys)))
        safety_result = await session.execute(
            YarnSafetyEvent.__table__.delete().where(YarnSafetyEvent.session_key.in_(keys))
        )
        sessions_result = await session.execute(YarnSession.__table__.delete().where(YarnSession.session_key.in_(keys)))
        await session.commit()
    return {
        "sessions": int(sessions_result.rowcount or 0),
        "usage_rows": int(usage_result.rowcount or 0),
        "events": int(events_result.rowcount or 0),
        "safety_events": int(safety_result.rowcount or 0),
    }


async def archive_yarn_sessions(
    *,
    session_keys: list[str] | None = None,
    older_than_days: int | None = None,
    session_key_prefix: str = "",
    dry_run: bool = True,
    delete_after_archive: bool = False,
    actor_user_id: str = "",
) -> dict:
    """Archive selected or old Yarn session records to object storage."""
    keys = await _select_session_keys(
        session_keys=session_keys,
        older_than_days=older_than_days,
        session_key_prefix=session_key_prefix,
    )
    counts = await _count_yarn_archive_rows(keys)
    result: dict[str, Any] = {
        "dry_run": dry_run,
        "delete_after_archive": delete_after_archive,
        "session_keys": len(keys),
        **counts,
        "archive": None,
        "deleted": None,
    }
    if dry_run or not keys:
        return result

    records = await _archive_records_for_yarn(keys)
    archive = await write_jsonl_archive(
        kind="yarn/sessions",
        records=records,
        manifest={
            "actor_user_id": actor_user_id,
            "older_than_days": older_than_days,
            "session_key_prefix": session_key_prefix,
            "session_key_count": len(keys),
            "counts": counts,
        },
    )
    result["archive"] = archive

    if delete_after_archive:
        result["deleted"] = await _delete_yarn_keys(keys)
    return result


async def delete_yarn_sessions(session_keys: list[str]) -> dict:
    keys = await _select_session_keys(session_keys=session_keys)
    counts = await _delete_yarn_keys(keys)
    return {"requested": len(session_keys), "session_keys": len(keys), **counts}


async def purge_yarn_sessions(
    older_than_days: int = 30,
    session_key_prefix: str = "",
    dry_run: bool = True,
    archive_before_delete: bool = False,
    actor_user_id: str = "",
) -> dict:
    """Delete sessions (and associated usage/events) older than a threshold.

    Returns counts of rows that would be (or were) deleted.
    """
    if archive_before_delete:
        return await archive_yarn_sessions(
            older_than_days=older_than_days,
            session_key_prefix=session_key_prefix,
            dry_run=dry_run,
            delete_after_archive=True,
            actor_user_id=actor_user_id,
        )

    keys = await _select_session_keys(older_than_days=older_than_days, session_key_prefix=session_key_prefix)
    counts = await _count_yarn_archive_rows(keys)
    if dry_run:
        return {"dry_run": True, **counts}

    deleted = await _delete_yarn_keys(keys)
    logger.info("purged_yarn_sessions older_than_days=%d sessions=%d", older_than_days, deleted["sessions"])
    return {"dry_run": False, **deleted}
