"""Dashboard summary endpoint."""

import asyncio
import logging

from fastapi import APIRouter, Depends

from ..auth import UserInfo, get_current_user
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
