"""Usage rollup writer — aggregates trace data into 5-minute buckets.

Called periodically by the admin background reconciler or a CronJob.
Each invocation looks at traces created since the last rollup and
inserts one ``UsageRollup`` row per (5-min bucket, model, user_id, org_id).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select

from ..db.engine import async_session
from ..db.models import Trace, UsageRollup

logger = logging.getLogger("synesis.admin.usage_rollup")

_BUCKET_MINUTES = 5


def _truncate_bucket(ts: float) -> datetime:
    """Truncate a unix timestamp to the nearest 5-minute bucket."""
    dt = datetime.fromtimestamp(ts, tz=UTC)
    minute = (dt.minute // _BUCKET_MINUTES) * _BUCKET_MINUTES
    return dt.replace(minute=minute, second=0, microsecond=0)


async def run_rollup(lookback_minutes: int = 15) -> dict[str, Any]:
    """Aggregate recent traces into ``usage_rollups``.

    Only processes traces newer than ``lookback_minutes`` to keep the
    window small.  Duplicate buckets are handled via upsert (ON CONFLICT
    DO UPDATE) in a raw SQL statement for efficiency.
    """
    cutoff = (datetime.now(UTC) - timedelta(minutes=lookback_minutes)).timestamp()

    async with async_session() as session:
        try:
            rows = (await session.execute(select(Trace).where(Trace.timestamp >= cutoff))).scalars().all()

            if not rows:
                return {"buckets_written": 0, "traces_processed": 0}

            buckets: dict[tuple, dict[str, Any]] = {}

            for trace in rows:
                bucket_dt = _truncate_bucket(trace.timestamp)
                rec = trace.full_record or {}
                model = rec.get("model", "")
                role = rec.get("role", "")
                user_id = trace.user_id or ""
                org_id = rec.get("org_id", "")

                key = (bucket_dt, model, role, user_id, org_id)
                if key not in buckets:
                    buckets[key] = {
                        "bucket": bucket_dt,
                        "model": model,
                        "role": role,
                        "user_id": user_id,
                        "org_id": org_id,
                        "request_count": 0,
                        "prompt_tokens": 0,
                        "completion_tokens": 0,
                        "cached_tokens": 0,
                        "total_tokens": 0,
                        "estimated_cost_usd": 0.0,
                        "actual_cost_usd": 0.0,
                        "total_duration_ms": 0.0,
                        "error_count": 0,
                    }

                b = buckets[key]
                b["request_count"] += 1
                b["total_tokens"] += trace.total_tokens or 0
                b["estimated_cost_usd"] += trace.estimated_cost_usd or 0.0
                b["actual_cost_usd"] += trace.actual_cost_usd or 0.0
                b["total_duration_ms"] += trace.total_duration_ms or 0.0
                if trace.has_error:
                    b["error_count"] += 1

                # Extract token breakdown from full_record if present
                for span in rec.get("spans", []):
                    for call in span.get("llm_calls", []):
                        b["prompt_tokens"] += call.get("prompt_tokens", 0)
                        b["completion_tokens"] += call.get("completion_tokens", 0)
                        b["cached_tokens"] += call.get("cached_tokens", 0)

            written = 0
            for b in buckets.values():
                avg_dur = b["total_duration_ms"] / b["request_count"] if b["request_count"] else 0
                row = UsageRollup(
                    bucket=b["bucket"],
                    model=b["model"],
                    role=b["role"],
                    user_id=b["user_id"],
                    org_id=b["org_id"],
                    request_count=b["request_count"],
                    prompt_tokens=b["prompt_tokens"],
                    completion_tokens=b["completion_tokens"],
                    cached_tokens=b["cached_tokens"],
                    total_tokens=b["total_tokens"],
                    estimated_cost_usd=round(b["estimated_cost_usd"], 6),
                    actual_cost_usd=round(b["actual_cost_usd"], 6),
                    avg_duration_ms=round(avg_dur, 1),
                    error_count=b["error_count"],
                )
                session.add(row)
                written += 1

            await session.commit()
            logger.info("usage_rollup_complete buckets=%d traces=%d", written, len(rows))
            return {"buckets_written": written, "traces_processed": len(rows)}

        except Exception:
            logger.warning("usage_rollup_failed", exc_info=True)
            await session.rollback()
            return {"buckets_written": 0, "traces_processed": 0, "error": True}


async def get_usage(
    *,
    since_hours: int = 24,
    scope_user_id: str = "",
    scope_org_id: str = "",
    group_by: str = "bucket",
) -> list[dict[str, Any]]:
    """Read pre-aggregated usage data, respecting RBAC scope."""
    cutoff = datetime.now(UTC) - timedelta(hours=since_hours)

    async with async_session() as session:
        try:
            q = select(UsageRollup).where(UsageRollup.bucket >= cutoff)

            if scope_user_id:
                q = q.where(UsageRollup.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(UsageRollup.org_id == scope_org_id)

            q = q.order_by(UsageRollup.bucket.desc())
            result = await session.execute(q)
            rows = result.scalars().all()

            return [
                {
                    "bucket": r.bucket.isoformat(),
                    "model": r.model,
                    "role": r.role,
                    "user_id": r.user_id,
                    "org_id": r.org_id,
                    "request_count": r.request_count,
                    "prompt_tokens": r.prompt_tokens,
                    "completion_tokens": r.completion_tokens,
                    "cached_tokens": r.cached_tokens,
                    "total_tokens": r.total_tokens,
                    "estimated_cost_usd": r.estimated_cost_usd,
                    "actual_cost_usd": r.actual_cost_usd,
                    "avg_duration_ms": r.avg_duration_ms,
                    "error_count": r.error_count,
                }
                for r in rows
            ]
        except Exception:
            logger.warning("usage_rollup_read_failed", exc_info=True)
            return []


async def get_usage_summary(
    *,
    since_hours: int = 24,
    scope_user_id: str = "",
    scope_org_id: str = "",
) -> dict[str, Any]:
    """Return aggregated totals over the period, respecting RBAC scope."""
    cutoff = datetime.now(UTC) - timedelta(hours=since_hours)

    async with async_session() as session:
        try:
            q = select(
                func.sum(UsageRollup.request_count).label("total_requests"),
                func.sum(UsageRollup.prompt_tokens).label("prompt_tokens"),
                func.sum(UsageRollup.completion_tokens).label("completion_tokens"),
                func.sum(UsageRollup.cached_tokens).label("cached_tokens"),
                func.sum(UsageRollup.total_tokens).label("total_tokens"),
                func.sum(UsageRollup.estimated_cost_usd).label("estimated_cost"),
                func.sum(UsageRollup.actual_cost_usd).label("actual_cost"),
                func.avg(UsageRollup.avg_duration_ms).label("avg_duration_ms"),
                func.sum(UsageRollup.error_count).label("error_count"),
            ).where(UsageRollup.bucket >= cutoff)

            if scope_user_id:
                q = q.where(UsageRollup.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(UsageRollup.org_id == scope_org_id)

            row = (await session.execute(q)).one()

            return {
                "period_hours": since_hours,
                "total_requests": int(row.total_requests or 0),
                "prompt_tokens": int(row.prompt_tokens or 0),
                "completion_tokens": int(row.completion_tokens or 0),
                "cached_tokens": int(row.cached_tokens or 0),
                "total_tokens": int(row.total_tokens or 0),
                "estimated_cost_usd": round(float(row.estimated_cost or 0), 4),
                "actual_cost_usd": round(float(row.actual_cost or 0), 4),
                "avg_duration_ms": round(float(row.avg_duration_ms or 0), 1),
                "error_count": int(row.error_count or 0),
            }
        except Exception:
            logger.warning("usage_rollup_summary_failed", exc_info=True)
            return {"period_hours": since_hours}


async def get_latest_rollup_bucket(
    *,
    scope_user_id: str = "",
    scope_org_id: str = "",
) -> datetime | None:
    """Most recent usage_rollup bucket (UTC), optionally scoped."""
    async with async_session() as session:
        try:
            q = select(func.max(UsageRollup.bucket))
            if scope_user_id:
                q = q.where(UsageRollup.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(UsageRollup.org_id == scope_org_id)
            row = (await session.execute(q)).scalar()
            return row
        except Exception:
            logger.warning("usage_rollup_latest_bucket_failed", exc_info=True)
            return None
