"""Dashboard summary endpoint."""

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy import func, select

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import BenchmarkResult, KnowledgeGap, QualitySnapshot, Trace
from ..deps import CURATOR_PROPOSALS_PATH, QUALITY_REPORT_PATH
from ..services import prometheus_client_svc as prom
from ..services import trace_store
from ..services.cost_estimator import get_cost_summary
from ..services.health_prober import probe_all
from ..services.model_registry import get_model_registry

logger = logging.getLogger("synesis.admin.dashboard")

router = APIRouter(prefix="/api/v1/dashboard", tags=["dashboard"])


async def _safe(coro, label: str, default=None):
    """Run an async callable and return *default* on failure."""
    try:
        return await coro
    except Exception as exc:
        logger.warning("dashboard_partial_error section=%s error=%s", label, str(exc)[:120])
        return default


@router.get("/summary")
async def dashboard_summary(_user: UserInfo = Depends(get_current_user)):
    (
        services,
        cache,
        raw,
        ts,
        cost_estimate,
    ) = await asyncio.gather(
        _safe(probe_all(), "probe_all", []),
        _safe(prom.get_cache_metrics(), "cache_metrics", {}),
        _safe(prom.fetch_planner_metrics(), "planner_metrics", {}),
        _safe(trace_store.get_trace_stats(), "trace_stats", {}),
        _safe(get_cost_summary(), "cost_summary", {}),
    )

    models = get_model_registry()
    healthy = sum(1 for s in (services or []) if isinstance(s, dict) and s.get("status") == "ok")
    total_requests = prom._find_metric(raw or {}, "synesis_chat_requests_total")

    return {
        "services": services or [],
        "metrics": {
            "total_requests": int(total_requests),
            "error_rate": (ts or {}).get("error_rate", 0),
            "avg_latency_ms": (ts or {}).get("avg_duration_ms", 0),
            "cache_hit_rate": (cache or {}).get("hit_rate", 0),
            "active_models": len(models),
            "traces_24h": (ts or {}).get("total_traces_24h", 0),
            "total_cost_24h": (ts or {}).get("total_cost_usd", 0),
        },
        "cost_estimate": cost_estimate or {},
        "healthy_count": healthy,
    }


# ---------------------------------------------------------------------------
# Quality wiring health — surfaces whether each feedback-loop data source is
# actually populated or reachable, so operators can distinguish "no data yet"
# from "broken pipeline".
# ---------------------------------------------------------------------------

import time as _time


async def _milvus_ok() -> bool:
    try:
        from ..services.milvus_service import collection_stats

        stats = collection_stats("synesis_catalog")
        return stats.get("row_count", 0) > 0
    except Exception:
        return False


async def _db_counts() -> dict:
    """Return counts and ages for key quality tables."""
    now = _time.time()
    cutoff_24h = now - 86400
    try:
        async with async_session() as session:
            trace_total = (await session.execute(select(func.count()).select_from(Trace))).scalar() or 0
            trace_recent = (
                await session.execute(
                    select(func.count()).select_from(Trace).where(Trace.timestamp >= cutoff_24h)
                )
            ).scalar() or 0
            last_trace_ts = (await session.execute(select(func.max(Trace.timestamp)))).scalar()

            gap_total = (await session.execute(select(func.count()).select_from(KnowledgeGap))).scalar() or 0
            gap_open = (
                await session.execute(
                    select(func.count())
                    .select_from(KnowledgeGap)
                    .where(KnowledgeGap.status.in_(["open", "reopened"]))
                )
            ).scalar() or 0

            snap_count = (await session.execute(select(func.count()).select_from(QualitySnapshot))).scalar() or 0
            last_snap = (await session.execute(select(func.max(QualitySnapshot.scored_at)))).scalar()

            bench_count = (await session.execute(select(func.count()).select_from(BenchmarkResult))).scalar() or 0
            last_bench = (await session.execute(select(func.max(BenchmarkResult.started_at)))).scalar()

        return {
            "traces_total": trace_total,
            "traces_24h": trace_recent,
            "last_trace_age_s": round(now - last_trace_ts, 1) if last_trace_ts else None,
            "knowledge_gaps_total": gap_total,
            "knowledge_gaps_open": gap_open,
            "quality_snapshots": snap_count,
            "last_snapshot_at": last_snap.isoformat() if last_snap else None,
            "benchmark_runs": bench_count,
            "last_benchmark_at": last_bench.isoformat() if last_bench else None,
        }
    except Exception:
        logger.debug("quality_wiring_db_counts_failed", exc_info=True)
        return {}


@router.get("/quality-wiring")
async def quality_wiring(_user: UserInfo = Depends(get_current_user)):
    """Diagnostic view: is every quality feedback loop source actually populated?"""
    milvus_ok, db = await asyncio.gather(
        _safe(_milvus_ok(), "milvus_check", False),
        _safe(_db_counts(), "db_counts", {}),
    )

    quality_report_present = bool(QUALITY_REPORT_PATH and Path(QUALITY_REPORT_PATH).exists())
    curator_file_present = bool(CURATOR_PROPOSALS_PATH and Path(CURATOR_PROPOSALS_PATH).exists())

    return {
        "milvus_ok": milvus_ok,
        "quality_report_present": quality_report_present,
        "curator_file_present": curator_file_present,
        **db,
    }
