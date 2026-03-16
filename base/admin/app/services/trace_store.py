"""Trace store backed by Postgres.

Reads trace records from the admin Postgres database.  The planner writes
traces via a direct Postgres insert (see base/planner/app/synesis_tracer.py).
"""

from __future__ import annotations

import logging
import time
from typing import Any

from sqlalchemy import case, desc, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.engine import async_session
from ..db.models import Trace

logger = logging.getLogger("synesis.admin.trace_store")


async def list_traces(
    *,
    offset: int = 0,
    limit: int = 50,
    has_error: bool | None = None,
    user_id: str = "",
    task_type: str = "",
    min_difficulty: float | None = None,
    max_difficulty: float | None = None,
    domain_tag: str = "",
    since: float = 0,
    until: float = 0,
) -> dict[str, Any]:
    """Return paginated trace list from Postgres, newest first."""
    async with async_session() as session:
        try:
            q = select(Trace).order_by(desc(Trace.timestamp))

            if has_error is not None:
                q = q.where(Trace.has_error == has_error)
            if user_id:
                q = q.where(Trace.user_id == user_id)
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
                q = q.where(
                    Trace.full_record["domain_tags"].astext.contains(domain_tag)
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


async def get_trace_stats() -> dict[str, Any]:
    """Aggregate statistics from recent traces (last 24h)."""
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


async def insert_trace(record: dict[str, Any]) -> None:
    """Insert a trace record (called by the planner trace writer)."""
    async with async_session() as session:
        try:
            trace = Trace(
                trace_id=record["trace_id"],
                user_id=record.get("user_id", ""),
                query_snippet=record.get("query_snippet", ""),
                timestamp=record["timestamp"],
                total_duration_ms=record.get("total_duration_ms", 0),
                total_tokens=record.get("total_tokens", 0),
                estimated_cost_usd=record.get("estimated_cost_usd", 0),
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


def _row_to_dict(row: Trace) -> dict[str, Any]:
    """Convert a Trace ORM row to the dict format expected by the frontend."""
    rec = dict(row.full_record) if row.full_record else {}
    rec.update(
        {
            "trace_id": row.trace_id,
            "user_id": row.user_id,
            "timestamp": row.timestamp,
            "total_duration_ms": row.total_duration_ms,
            "total_tokens": row.total_tokens,
            "estimated_cost_usd": row.estimated_cost_usd,
            "has_error": row.has_error,
            "task_type": row.task_type,
            "difficulty": row.difficulty,
        }
    )
    return rec


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
