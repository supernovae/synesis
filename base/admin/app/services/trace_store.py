"""Trace store backed by Postgres.

Reads trace records from the admin Postgres database.  The planner writes
traces via a direct Postgres insert (see base/planner/app/synesis_tracer.py).
"""

from __future__ import annotations

import logging
import time
from typing import Any

import sqlalchemy as sa
from sqlalchemy import case, desc, func, select

from ..db.engine import async_session
from ..db.models import Trace

logger = logging.getLogger("synesis.admin.trace_store")


async def list_traces(
    *,
    offset: int = 0,
    limit: int = 50,
    has_error: bool | None = None,
    user_id: str = "",
    user_email: str = "",
    org_id: str = "",
    conversation_id: str = "",
    task_type: str = "",
    min_difficulty: float | None = None,
    max_difficulty: float | None = None,
    domain_tag: str = "",
    since: float = 0,
    until: float = 0,
    max_tokens: int | None = None,
    min_hallucinated_urls: int | None = None,
    scope_user_id: str = "",
    scope_org_id: str = "",
    scope_tenant_id: str = "",
) -> dict[str, Any]:
    """Return paginated trace list from Postgres, newest first.

    ``scope_user_id`` / ``scope_org_id`` / ``scope_tenant_id`` are RBAC-enforced
    filters injected by the router — they take priority and cannot be widened by
    query params.
    """
    async with async_session() as session:
        try:
            q = select(Trace).order_by(desc(Trace.timestamp))

            if scope_user_id:
                q = q.where(Trace.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(Trace.full_record["org_id"].astext == scope_org_id)

            if scope_tenant_id:
                q = q.where(Trace.tenant_id == scope_tenant_id)

            if has_error is not None:
                q = q.where(Trace.has_error == has_error)
            if user_id:
                q = q.where(Trace.user_id == user_id)
            if conversation_id:
                q = q.where(Trace.conversation_id == conversation_id)
            if user_email:
                q = q.where(Trace.full_record["user_email"].astext == user_email)
            if org_id:
                q = q.where(Trace.full_record["org_id"].astext == org_id)
            if task_type:
                q = q.where(Trace.task_type == task_type)
            if min_difficulty is not None:
                q = q.where(Trace.difficulty >= min_difficulty)
            if max_difficulty is not None:
                q = q.where(Trace.difficulty <= max_difficulty)
            if since > 0:
                q = q.where(Trace.timestamp >= since)
            if until > 0:
                q = q.where(Trace.timestamp <= until)
            if domain_tag:
                q = q.where(Trace.full_record["domain_tags"].astext.contains(domain_tag))
            if max_tokens is not None:
                q = q.where(Trace.total_tokens <= max_tokens)
            if min_hallucinated_urls is not None and min_hallucinated_urls > 0:
                from sqlalchemy import Integer as SAInt
                from sqlalchemy import cast

                q = q.where(
                    cast(
                        Trace.full_record["critic_scores"]["hallucinated_urls_count"].astext,
                        SAInt,
                    )
                    >= min_hallucinated_urls
                )

            count_q = select(func.count()).select_from(q.subquery())
            total = (await session.execute(count_q)).scalar_one()

            q = q.offset(offset).limit(limit)
            result = await session.execute(q)
            rows = result.scalars().all()

            traces = [_row_to_dict(row) for row in rows]
            return {"traces": traces, "total": total}
        except Exception:
            logger.warning("trace_store_list_failed", exc_info=True)
            return {"traces": [], "total": 0}


async def get_trace(trace_id: str) -> dict[str, Any] | None:
    async with async_session() as session:
        try:
            q = select(Trace).where(Trace.trace_id == trace_id)
            result = await session.execute(q)
            row = result.scalar_one_or_none()
            if row is None:
                return None
            return _row_to_dict(row)
        except Exception:
            logger.warning("trace_store_get_failed", exc_info=True)
            return None


async def get_trace_stats(
    *,
    scope_user_id: str = "",
    scope_org_id: str = "",
    scope_tenant_id: str = "",
) -> dict[str, Any]:
    """Aggregate statistics from recent traces (last 24h), respecting RBAC scope."""
    cutoff = time.time() - 86400
    async with async_session() as session:
        try:
            q = select(
                func.count().label("total"),
                func.sum(case((Trace.has_error == True, 1), else_=0)).label("errors"),
                func.avg(Trace.total_duration_ms).label("avg_duration"),
                func.avg(Trace.total_tokens).label("avg_tokens"),
                func.avg(Trace.estimated_cost_usd).label("avg_cost"),
                func.sum(Trace.estimated_cost_usd).label("total_cost"),
            ).where(Trace.timestamp >= cutoff)

            if scope_user_id:
                q = q.where(Trace.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(Trace.full_record["org_id"].astext == scope_org_id)

            if scope_tenant_id:
                q = q.where(Trace.tenant_id == scope_tenant_id)

            result = await session.execute(q)
            row = result.one()

            total = row.total or 0
            errors = row.errors or 0

            if total == 0:
                return _empty_stats()

            return {
                "total_traces_24h": total,
                "error_count_24h": errors,
                "error_rate": round(errors / total, 4),
                "avg_duration_ms": round(float(row.avg_duration or 0), 1),
                "avg_tokens": round(float(row.avg_tokens or 0)),
                "avg_cost_usd": round(float(row.avg_cost or 0), 6),
                "total_cost_usd": round(float(row.total_cost or 0), 4),
                "traces_per_hour": round(total / 24, 1),
            }
        except Exception:
            logger.warning("trace_store_stats_failed", exc_info=True)
            return _empty_stats()


async def aggregate_traces_period(
    *,
    since_hours: int = 24,
    scope_user_id: str = "",
    scope_org_id: str = "",
    scope_tenant_id: str = "",
) -> dict[str, Any]:
    """Sum trace-level tokens and costs over a window (RBAC-scoped)."""
    cutoff = time.time() - since_hours * 3600
    async with async_session() as session:
        try:
            q = select(
                func.count().label("n"),
                func.coalesce(func.sum(Trace.total_tokens), 0).label("total_tokens"),
                func.coalesce(func.sum(Trace.estimated_cost_usd), 0).label("estimated_cost_usd"),
                func.coalesce(func.sum(Trace.actual_cost_usd), 0).label("actual_cost_usd"),
            ).where(Trace.timestamp >= cutoff)
            if scope_user_id:
                q = q.where(Trace.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(Trace.full_record["org_id"].astext == scope_org_id)

            if scope_tenant_id:
                q = q.where(Trace.tenant_id == scope_tenant_id)

            row = (await session.execute(q)).one()
            return {
                "period_hours": since_hours,
                "trace_count": int(row.n or 0),
                "total_tokens": int(row.total_tokens or 0),
                "estimated_cost_usd": round(float(row.estimated_cost_usd or 0), 4),
                "actual_cost_usd": round(float(row.actual_cost_usd or 0), 4),
            }
        except Exception:
            logger.warning("trace_store_aggregate_period_failed", exc_info=True)
            return {
                "period_hours": since_hours,
                "trace_count": 0,
                "total_tokens": 0,
                "estimated_cost_usd": 0.0,
                "actual_cost_usd": 0.0,
            }


async def insert_trace(record: dict[str, Any]) -> None:
    """Insert a trace record (called by the planner trace writer)."""
    async with async_session() as session:
        try:
            org_id = record.get("org_id", "")
            tenant_id = record.get("tenant_id", "")
            trace = Trace(
                trace_id=record["trace_id"],
                user_id=record.get("user_id", ""),
                org_id=org_id,
                tenant_id=tenant_id,
                query_snippet=record.get("query_snippet", ""),
                timestamp=record["timestamp"],
                total_duration_ms=record.get("total_duration_ms", 0),
                total_tokens=record.get("total_tokens", 0),
                estimated_cost_usd=record.get("estimated_cost_usd", 0),
                actual_cost_usd=record.get("actual_cost_usd", 0),
                difficulty=record.get("difficulty", 0),
                task_type=record.get("task_type", ""),
                is_code_task=record.get("is_code_task", False),
                has_error=record.get("has_error", False),
                iteration_count=record.get("iteration_count", 0),
                full_record=record,
            )
            session.add(trace)
            await session.commit()
        except Exception:
            logger.warning("trace_store_insert_failed", exc_info=True)
            await session.rollback()


async def upsert_trace(record: dict[str, Any]) -> None:
    """Insert or update a trace record (used by the /ingest endpoint)."""
    async with async_session() as session:
        try:
            from sqlalchemy.dialects.postgresql import insert as pg_insert

            stmt = pg_insert(Trace).values(
                trace_id=record["trace_id"],
                user_id=record.get("user_id", ""),
                org_id=record.get("org_id", ""),
                tenant_id=record.get("tenant_id", ""),
                query_snippet=record.get("query_snippet", ""),
                timestamp=record["timestamp"],
                total_duration_ms=record.get("total_duration_ms", 0),
                total_tokens=record.get("total_tokens", 0),
                estimated_cost_usd=record.get("estimated_cost_usd", 0),
                actual_cost_usd=record.get("actual_cost_usd", 0),
                difficulty=record.get("difficulty", 0),
                task_type=record.get("task_type", ""),
                is_code_task=record.get("is_code_task", False),
                has_error=record.get("has_error", False),
                iteration_count=record.get("iteration_count", 0),
                full_record=record.get("full_record", record),
            )
            stmt = stmt.on_conflict_do_update(
                index_elements=["trace_id"],
                set_={
                    "total_duration_ms": sa.func.greatest(
                        Trace.total_duration_ms, stmt.excluded.total_duration_ms,
                    ),
                    "total_tokens": sa.func.greatest(
                        Trace.total_tokens, stmt.excluded.total_tokens,
                    ),
                    "estimated_cost_usd": sa.func.greatest(
                        Trace.estimated_cost_usd, stmt.excluded.estimated_cost_usd,
                    ),
                    "actual_cost_usd": sa.func.greatest(
                        Trace.actual_cost_usd, stmt.excluded.actual_cost_usd,
                    ),
                    "full_record": sa.func.coalesce(Trace.full_record, sa.text("'{}'::jsonb")).op("||")(
                        stmt.excluded.full_record,
                    ),
                },
            )
            await session.execute(stmt)
            await session.commit()
        except Exception:
            logger.warning("trace_store_upsert_failed", exc_info=True)
            await session.rollback()


def _row_to_dict(row: Trace) -> dict[str, Any]:
    """Convert a Trace ORM row to the dict format expected by the frontend."""
    rec = dict(row.full_record) if row.full_record else {}
    rec.update(
        {
            "trace_id": row.trace_id,
            "user_id": row.user_id,
            "conversation_id": getattr(row, "conversation_id", None),
            "parent_trace_id": getattr(row, "parent_trace_id", None),
            "root_trace_id": getattr(row, "root_trace_id", None),
            "timestamp": row.timestamp,
            "total_duration_ms": row.total_duration_ms,
            "total_tokens": row.total_tokens,
            "estimated_cost_usd": row.estimated_cost_usd,
            "actual_cost_usd": row.actual_cost_usd,
            "has_error": row.has_error,
            "task_type": row.task_type,
            "difficulty": row.difficulty,
        }
    )
    return rec


async def delete_traces_for_conversation(conversation_id: str) -> int:
    """Delete all traces for a chat session (admin purge)."""
    from sqlalchemy import delete

    if not (conversation_id or "").strip():
        return 0
    async with async_session() as session:
        try:
            r = await session.execute(delete(Trace).where(Trace.conversation_id == conversation_id.strip()[:128]))
            await session.commit()
            return r.rowcount or 0
        except Exception:
            logger.warning("trace_store_delete_conversation_failed", exc_info=True)
            await session.rollback()
            return 0


def _empty_stats() -> dict[str, Any]:
    return {
        "total_traces_24h": 0,
        "error_count_24h": 0,
        "error_rate": 0,
        "avg_duration_ms": 0,
        "avg_tokens": 0,
        "avg_cost_usd": 0,
        "total_cost_usd": 0,
        "traces_per_hour": 0,
    }
