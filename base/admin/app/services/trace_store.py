"""Read-only client for SynesisTracer trace records stored in Redis.

Mirrors the storage schema from base/planner/app/synesis_tracer.py:
  - synesis:traces:{trace_id}  → JSON blob (TraceRecord)
  - synesis:traces:index       → ZSET scored by timestamp
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from ..deps import REDIS_URL

logger = logging.getLogger("synesis.admin.trace_store")

_TRACE_KEY_PREFIX = "synesis:traces:"
_TRACE_INDEX_KEY = "synesis:traces:index"

_redis_client: Any = None


def _get_redis() -> Any:
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    if not REDIS_URL:
        return None
    try:
        import redis as redis_lib

        _redis_client = redis_lib.Redis.from_url(REDIS_URL, decode_responses=True)
        _redis_client.ping()
        return _redis_client
    except Exception:
        logger.warning("trace_store_redis_failed", exc_info=True)
        return None


def _parse_trace(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


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
    """Return paginated trace list from Redis, newest first."""
    r = _get_redis()
    if r is None:
        return {"traces": [], "total": 0}

    max_score = until if until > 0 else "+inf"
    min_score = since if since > 0 else "-inf"

    try:
        total = r.zcount(_TRACE_INDEX_KEY, min_score, max_score)
        trace_ids = r.zrevrangebyscore(
            _TRACE_INDEX_KEY,
            max_score,
            min_score,
            start=0,
            num=offset + limit + 200,
        )
    except Exception:
        logger.debug("trace_store_list_failed", exc_info=True)
        return {"traces": [], "total": 0}

    if not trace_ids:
        return {"traces": [], "total": 0}

    keys = [f"{_TRACE_KEY_PREFIX}{tid}" for tid in trace_ids]
    try:
        raw_values = r.mget(keys)
    except Exception:
        logger.debug("trace_store_mget_failed", exc_info=True)
        return {"traces": [], "total": 0}

    traces: list[dict[str, Any]] = []
    for raw in raw_values:
        rec = _parse_trace(raw)
        if rec is None:
            continue
        if has_error is not None and rec.get("has_error") != has_error:
            continue
        if user_id and rec.get("user_id") != user_id:
            continue
        if task_type and rec.get("task_type") != task_type:
            continue
        if min_difficulty is not None and rec.get("difficulty", 0) < min_difficulty:
            continue
        if max_difficulty is not None and rec.get("difficulty", 0) > max_difficulty:
            continue
        if domain_tag and domain_tag not in (rec.get("domain_tags") or []):
            continue
        traces.append(rec)

    filtered_total = len(traces)
    page = traces[offset : offset + limit]

    return {"traces": page, "total": filtered_total}


async def get_trace(trace_id: str) -> dict[str, Any] | None:
    r = _get_redis()
    if r is None:
        return None
    try:
        raw = r.get(f"{_TRACE_KEY_PREFIX}{trace_id}")
        return _parse_trace(raw)
    except Exception:
        logger.debug("trace_store_get_failed", exc_info=True)
        return None


async def get_trace_stats() -> dict[str, Any]:
    """Aggregate statistics from recent traces (last 24h)."""
    r = _get_redis()
    if r is None:
        return _empty_stats()

    cutoff = time.time() - 86400
    try:
        trace_ids = r.zrevrangebyscore(_TRACE_INDEX_KEY, "+inf", cutoff, start=0, num=1000)
    except Exception:
        return _empty_stats()

    if not trace_ids:
        return _empty_stats()

    keys = [f"{_TRACE_KEY_PREFIX}{tid}" for tid in trace_ids]
    try:
        raw_values = r.mget(keys)
    except Exception:
        return _empty_stats()

    durations: list[float] = []
    costs: list[float] = []
    tokens: list[int] = []
    errors = 0
    total = 0

    for raw in raw_values:
        rec = _parse_trace(raw)
        if rec is None:
            continue
        total += 1
        durations.append(rec.get("total_duration_ms", 0))
        costs.append(rec.get("estimated_cost_usd", 0))
        tokens.append(rec.get("total_tokens", 0))
        if rec.get("has_error"):
            errors += 1

    if total == 0:
        return _empty_stats()

    return {
        "total_traces_24h": total,
        "error_count_24h": errors,
        "error_rate": round(errors / total, 4) if total else 0,
        "avg_duration_ms": round(sum(durations) / total, 1),
        "avg_tokens": round(sum(tokens) / total),
        "avg_cost_usd": round(sum(costs) / total, 6),
        "total_cost_usd": round(sum(costs), 4),
        "traces_per_hour": round(total / 24, 1),
    }


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
