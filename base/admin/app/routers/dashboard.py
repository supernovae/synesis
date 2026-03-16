"""Dashboard summary endpoint."""

from fastapi import APIRouter, Depends

from ..auth import UserInfo, get_current_user
from ..services import prometheus_client_svc as prom
from ..services import trace_store
from ..services.cost_estimator import get_cost_summary
from ..services.health_prober import probe_all
from ..services.model_registry import get_model_registry

router = APIRouter(prefix="/api/v1/dashboard", tags=["dashboard"])


@router.get("/summary")
async def dashboard_summary(_user: UserInfo = Depends(get_current_user)):
    services = await probe_all()
    healthy = sum(1 for s in services if s["status"] == "ok")
    cache = await prom.get_cache_metrics()
    models = get_model_registry()

    raw = await prom.fetch_planner_metrics()
    total_requests = prom._find_metric(raw, "synesis_chat_requests_total")

    ts = await trace_store.get_trace_stats()
    cost_estimate = await get_cost_summary()

    return {
        "services": services,
        "metrics": {
            "total_requests": int(total_requests),
            "error_rate": ts.get("error_rate", 0),
            "avg_latency_ms": ts.get("avg_duration_ms", 0),
            "cache_hit_rate": cache.get("hit_rate", 0),
            "active_models": len(models),
            "traces_24h": ts.get("total_traces_24h", 0),
            "total_cost_24h": ts.get("total_cost_usd", 0),
        },
        "cost_estimate": cost_estimate,
        "healthy_count": healthy,
    }
