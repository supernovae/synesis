"""Model registry, deployments, cost, and performance endpoints."""

import logging
import time
from datetime import date as date_type, datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import text

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..services import prometheus_client_svc as prom
from ..services.model_registry import (
    activate_environment,
    create_deployment,
    delete_deployment,
    get_cost_by_model,
    get_cost_estimates,
    get_model_deployments,
    get_model_registry,
    seed_model_deployments,
    set_deployment_active,
    update_deployment,
    upsert_model_cost,
)

logger = logging.getLogger("synesis.admin.models_router")
router = APIRouter(prefix="/api/v1/models", tags=["models"])


# ---------------------------------------------------------------------------
# Legacy YAML-based registry (backward compat)
# ---------------------------------------------------------------------------

@router.get("/")
async def list_models(_user: UserInfo = Depends(get_current_user)):
    return {"models": get_model_registry()}


@router.get("/topology")
async def model_topology(_user: UserInfo = Depends(get_current_user)):
    from ..services.model_registry import get_model_topology

    return await get_model_topology()


# ---------------------------------------------------------------------------
# DB-first model deployments CRUD
# ---------------------------------------------------------------------------

@router.get("/deployments")
async def list_deployments(_user: UserInfo = Depends(get_current_user)):
    deployments = await get_model_deployments()
    return {"deployments": deployments}


@router.post("/deployments")
async def create_model_deployment(
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    if not data.get("environment") or not data.get("role"):
        raise HTTPException(400, "environment and role are required")
    return await create_deployment(data)


@router.put("/deployments/{deployment_id}")
async def update_model_deployment(
    deployment_id: int,
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    result = await update_deployment(deployment_id, data)
    if result is None:
        raise HTTPException(404, "deployment not found")
    return result


@router.delete("/deployments/{deployment_id}")
async def delete_model_deployment(
    deployment_id: int,
    _user: UserInfo = Depends(get_current_user),
):
    from ..services.model_reconciler import reconcile_single

    ok = await delete_deployment(deployment_id)
    if not ok:
        raise HTTPException(404, "deployment not found")
    return {"deleted": deployment_id}


@router.post("/deployments/{deployment_id}/activate")
async def activate_deployment(
    deployment_id: int,
    _user: UserInfo = Depends(get_current_user),
):
    from ..services.model_reconciler import reconcile_single

    result = await set_deployment_active(deployment_id, True)
    if result is None:
        raise HTTPException(404, "deployment not found")
    try:
        await reconcile_single(deployment_id)
    except Exception:
        logger.warning("reconcile_after_activate_failed id=%d", deployment_id, exc_info=True)
    return result


@router.post("/deployments/{deployment_id}/deactivate")
async def deactivate_deployment(
    deployment_id: int,
    _user: UserInfo = Depends(get_current_user),
):
    from ..services.model_reconciler import reconcile_single

    result = await set_deployment_active(deployment_id, False)
    if result is None:
        raise HTTPException(404, "deployment not found")
    try:
        await reconcile_single(deployment_id)
    except Exception:
        logger.warning("reconcile_after_deactivate_failed id=%d", deployment_id, exc_info=True)
    return result


@router.post("/deployments/activate-environment")
async def activate_env(
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    from ..services.model_reconciler import reconcile

    env = data.get("environment", "")
    if not env:
        raise HTTPException(400, "environment is required")
    updated = await activate_environment(env)
    try:
        await reconcile()
    except Exception:
        logger.warning("reconcile_after_env_activate_failed", exc_info=True)
    return {"environment": env, "deployments": updated}


@router.post("/sync-from-yaml")
async def sync_from_yaml(_user: UserInfo = Depends(get_current_user)):
    from ..services.model_registry import invalidate_yaml_cache

    invalidate_yaml_cache()
    count = await seed_model_deployments(force=True)
    return {"seeded": count}


@router.post("/reconcile")
async def trigger_reconcile(_user: UserInfo = Depends(get_current_user)):
    from ..services.model_reconciler import reconcile

    summary = await reconcile()
    return summary


@router.put("/deployments/{deployment_id}/fallbacks")
async def set_fallbacks(
    deployment_id: int,
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    """Set fallback model names for a deployment. Body: {"fallbacks": ["model-a", "model-b"]}."""
    fallbacks = data.get("fallbacks", [])
    result = await update_deployment(deployment_id, {"fallbacks": fallbacks if fallbacks else None})
    if result is None:
        raise HTTPException(404, "deployment not found")
    from ..services.model_reconciler import reconcile

    try:
        await reconcile()
    except Exception:
        logger.warning("reconcile_after_fallback_update_failed id=%d", deployment_id, exc_info=True)
    return result


# ---------------------------------------------------------------------------
# Costs
# ---------------------------------------------------------------------------

@router.get("/costs")
async def model_costs(_user: UserInfo = Depends(get_current_user)):
    costs = await get_cost_estimates()
    return {"roles": costs}


@router.put("/costs")
async def update_model_cost(
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    result = await upsert_model_cost(data)
    return result


@router.get("/costs/by-model")
async def costs_by_model(
    _user: UserInfo = Depends(get_current_user),
    days: int = Query(7, ge=1, le=90),
):
    """Per-model cost breakdown including estimated and actual costs."""
    cutoff = time.time() - days * 86400
    try:
        async with async_session() as session:
            result = await session.execute(
                text("SELECT full_record, estimated_cost_usd, actual_cost_usd FROM traces WHERE timestamp >= :cutoff"),
                {"cutoff": cutoff},
            )
            rows = result.all()

        model_agg: dict[str, dict] = {}
        for row in rows:
            full = row[0] or {}
            for span in full.get("spans", []):
                for call in span.get("llm_calls", []):
                    model = call.get("model", "unknown")
                    if model not in model_agg:
                        model_agg[model] = {
                            "model": model,
                            "prompt_tokens": 0,
                            "completion_tokens": 0,
                            "requests": 0,
                            "estimated_cost_usd": 0.0,
                            "actual_cost_usd": 0.0,
                        }
                    agg = model_agg[model]
                    agg["prompt_tokens"] += call.get("prompt_tokens", 0)
                    agg["completion_tokens"] += call.get("completion_tokens", 0)
                    agg["requests"] += 1
                    agg["actual_cost_usd"] += float(call.get("actual_cost", 0.0) or 0.0)

        cost_rates = await get_cost_estimates()
        model_pricing: dict[str, tuple[float, float]] = {}
        for c in cost_rates:
            model_pricing[c.get("model", "")] = (c["input_per_million"], c["output_per_million"])

        for model, agg in model_agg.items():
            rates = model_pricing.get(model, (0, 0))
            agg["estimated_cost_usd"] = round(
                (agg["prompt_tokens"] / 1_000_000) * rates[0] + (agg["completion_tokens"] / 1_000_000) * rates[1],
                6,
            )
            agg["actual_cost_usd"] = round(agg["actual_cost_usd"], 6)

        return {
            "models": sorted(model_agg.values(), key=lambda x: x["actual_cost_usd"] or x["estimated_cost_usd"], reverse=True),
            "period_days": days,
        }
    except Exception:
        logger.warning("costs_by_model_failed", exc_info=True)
        return {"models": await get_cost_by_model(), "period_days": days}


@router.get("/costs/by-role")
async def costs_by_role(
    _user: UserInfo = Depends(get_current_user),
    days: int = Query(7, ge=1, le=90),
):
    """Per-role cost breakdown from trace LLM calls, with estimated and actual costs."""
    cutoff = time.time() - days * 86400
    try:
        async with async_session() as session:
            result = await session.execute(
                text("SELECT full_record FROM traces WHERE timestamp >= :cutoff"),
                {"cutoff": cutoff},
            )
            rows = result.all()

        role_agg: dict[str, dict] = {}
        for row in rows:
            full = row[0] or {}
            for span in full.get("spans", []):
                node = span.get("node_name", "unknown")
                for call in span.get("llm_calls", []):
                    role = _infer_role(node, call.get("model", ""))
                    if role not in role_agg:
                        role_agg[role] = {
                            "role": role,
                            "prompt_tokens": 0,
                            "completion_tokens": 0,
                            "requests": 0,
                            "estimated_cost_usd": 0.0,
                            "actual_cost_usd": 0.0,
                        }
                    agg = role_agg[role]
                    agg["prompt_tokens"] += call.get("prompt_tokens", 0)
                    agg["completion_tokens"] += call.get("completion_tokens", 0)
                    agg["requests"] += 1
                    agg["actual_cost_usd"] += float(call.get("actual_cost", 0.0) or 0.0)

        cost_rates = await get_cost_estimates()
        pricing: dict[str, tuple[float, float]] = {}
        for c in cost_rates:
            pricing[c.get("role", "")] = (c["input_per_million"], c["output_per_million"])

        for role, agg in role_agg.items():
            rates = pricing.get(role, (0, 0))
            agg["estimated_cost_usd"] = round(
                (agg["prompt_tokens"] / 1_000_000) * rates[0] + (agg["completion_tokens"] / 1_000_000) * rates[1],
                6,
            )
            agg["actual_cost_usd"] = round(agg["actual_cost_usd"], 6)

        return {
            "roles": sorted(role_agg.values(), key=lambda x: x["actual_cost_usd"] or x["estimated_cost_usd"], reverse=True),
            "period_days": days,
        }
    except Exception:
        logger.warning("costs_by_role_failed", exc_info=True)
        return {"roles": [], "period_days": days}


def _infer_role(node_name: str, model_name: str) -> str:
    node_lower = node_name.lower()
    model_lower = model_name.lower()
    if "router" in node_lower or "router" in model_lower:
        return "router"
    if "critic" in node_lower or "critic" in model_lower:
        return "critic"
    if "coder" in node_lower or "coder" in model_lower:
        return "coder"
    if "writer" in node_lower or "planner" in node_lower:
        return "general"
    if "general" in model_lower:
        return "general"
    return node_name or "unknown"


@router.get("/costs/daily")
async def costs_daily(
    _user: UserInfo = Depends(get_current_user),
    days: int = Query(7, ge=1, le=90),
):
    """Per-day cost rollup with both estimated and actual costs."""
    cutoff = time.time() - days * 86400
    try:
        async with async_session() as session:
            result = await session.execute(
                text(
                    """
                    SELECT
                        DATE(to_timestamp(timestamp)) AS day,
                        SUM(total_tokens)::bigint AS tokens,
                        COUNT(*)::int AS requests,
                        SUM(estimated_cost_usd) AS estimated_cost,
                        SUM(actual_cost_usd) AS actual_cost
                    FROM traces
                    WHERE timestamp >= :cutoff
                    GROUP BY DATE(to_timestamp(timestamp))
                    ORDER BY day
                    """
                ),
                {"cutoff": cutoff},
            )
            rows = result.all()
            return {
                "daily": [
                    {
                        "date": str(r.day),
                        "tokens": int(r.tokens or 0),
                        "requests": r.requests,
                        "estimated_cost_usd": round(float(r.estimated_cost or 0), 6),
                        "actual_cost_usd": round(float(r.actual_cost or 0), 6),
                    }
                    for r in rows
                ],
                "period_days": days,
            }
    except Exception:
        logger.warning("costs_daily_failed", exc_info=True)
        return {"daily": [], "period_days": days}


@router.get("/costs/rate-history")
async def cost_rate_history(
    _user: UserInfo = Depends(get_current_user),
    days: int = Query(90, ge=1, le=365),
):
    """Cost rate change history from cost_rate_snapshots."""
    cutoff = datetime.now(timezone.utc).timestamp() - days * 86400
    try:
        async with async_session() as session:
            result = await session.execute(
                text(
                    """
                    SELECT model, role, input_per_million, output_per_million, source,
                           captured_at
                    FROM cost_rate_snapshots
                    WHERE EXTRACT(EPOCH FROM captured_at) >= :cutoff
                    ORDER BY captured_at
                    """
                ),
                {"cutoff": cutoff},
            )
            rows = result.all()
            return {
                "snapshots": [
                    {
                        "model": r.model,
                        "role": r.role,
                        "input_per_million": r.input_per_million,
                        "output_per_million": r.output_per_million,
                        "source": r.source,
                        "captured_at": r.captured_at.isoformat() if r.captured_at else None,
                    }
                    for r in rows
                ],
                "period_days": days,
            }
    except Exception:
        logger.warning("cost_rate_history_failed", exc_info=True)
        return {"snapshots": [], "period_days": days}


# ---------------------------------------------------------------------------
# Performance (legacy Prometheus)
# ---------------------------------------------------------------------------

@router.get("/performance")
async def model_performance(_user: UserInfo = Depends(get_current_user)):
    models = await prom.get_model_performance()
    return {"models": models, "period": "24h"}


# ---------------------------------------------------------------------------
# Performance (trace-based detailed)
# ---------------------------------------------------------------------------

@router.get("/performance/detailed")
async def performance_detailed(
    _user: UserInfo = Depends(get_current_user),
    days: int = Query(7, ge=1, le=90),
):
    """Per-model performance metrics aggregated from trace LLM calls."""
    cutoff = time.time() - days * 86400
    try:
        async with async_session() as session:
            result = await session.execute(
                text("SELECT full_record FROM traces WHERE timestamp >= :cutoff"),
                {"cutoff": cutoff},
            )
            rows = result.all()

        model_stats: dict[str, dict] = {}
        for row in rows:
            full = row[0] or {}
            for span in full.get("spans", []):
                for call in span.get("llm_calls", []):
                    model = call.get("model", "unknown")
                    if model not in model_stats:
                        model_stats[model] = {
                            "model": model,
                            "request_count": 0,
                            "latencies": [],
                            "total_tokens": 0,
                            "total_prompt_tokens": 0,
                            "total_completion_tokens": 0,
                            "total_actual_cost": 0.0,
                        }
                    ms = model_stats[model]
                    lat = call.get("latency_ms", 0)
                    ms["request_count"] += 1
                    ms["latencies"].append(lat)
                    ms["total_tokens"] += call.get("total_tokens", 0)
                    ms["total_prompt_tokens"] += call.get("prompt_tokens", 0)
                    ms["total_completion_tokens"] += call.get("completion_tokens", 0)
                    ms["total_actual_cost"] += float(call.get("actual_cost", 0.0) or 0.0)

        results = []
        for ms in model_stats.values():
            lats = sorted(ms.pop("latencies"))
            n = len(lats)
            avg_lat = sum(lats) / n if n else 0
            p95_idx = int(n * 0.95) if n else 0
            p95_lat = lats[min(p95_idx, n - 1)] if n else 0
            ms["avg_latency_ms"] = round(avg_lat, 1)
            ms["p95_latency_ms"] = round(p95_lat, 1)
            ms["total_actual_cost"] = round(ms["total_actual_cost"], 6)
            results.append(ms)

        results.sort(key=lambda x: x["request_count"], reverse=True)
        return {"models": results, "period_days": days}

    except Exception:
        logger.warning("performance_detailed_failed", exc_info=True)
        return {"models": [], "period_days": days}


@router.get("/performance/latency-trend")
async def latency_trend(
    _user: UserInfo = Depends(get_current_user),
    days: int = Query(14, ge=1, le=90),
):
    """Per-model daily latency trend from trace LLM calls."""
    cutoff = time.time() - days * 86400
    try:
        async with async_session() as session:
            result = await session.execute(
                text("SELECT timestamp, full_record FROM traces WHERE timestamp >= :cutoff"),
                {"cutoff": cutoff},
            )
            rows = result.all()

        DayModel = tuple[str, str]  # (date_str, model)
        agg: dict[DayModel, dict] = {}
        for row in rows:
            ts = row[0]
            full = row[1] or {}
            day_str = date_type.fromtimestamp(ts).isoformat()
            for span in full.get("spans", []):
                for call in span.get("llm_calls", []):
                    model = call.get("model", "unknown")
                    key: DayModel = (day_str, model)
                    if key not in agg:
                        agg[key] = {"sum_lat": 0.0, "count": 0}
                    agg[key]["sum_lat"] += call.get("latency_ms", 0)
                    agg[key]["count"] += 1

        trend = [
            {
                "date": k[0],
                "model": k[1],
                "avg_latency_ms": round(v["sum_lat"] / v["count"], 1) if v["count"] else 0,
                "request_count": v["count"],
            }
            for k, v in sorted(agg.items())
        ]
        return {"trend": trend, "period_days": days}

    except Exception:
        logger.warning("latency_trend_failed", exc_info=True)
        return {"trend": [], "period_days": days}
