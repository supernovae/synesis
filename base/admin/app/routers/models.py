"""Model registry, cost, and performance endpoints."""

import logging
import time

from fastapi import APIRouter, Body, Depends, Query
from sqlalchemy import text

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..services import prometheus_client_svc as prom
from ..services.model_registry import (
    get_cost_by_model,
    get_cost_estimates,
    get_model_registry,
    upsert_model_cost,
)

logger = logging.getLogger("synesis.admin.models_router")
router = APIRouter(prefix="/api/v1/models", tags=["models"])


@router.get("/")
async def list_models(_user: UserInfo = Depends(get_current_user)):
    return {"models": get_model_registry()}


@router.get("/topology")
async def model_topology(_user: UserInfo = Depends(get_current_user)):
    """Structured deployment topology: environments x roles x models with status."""
    from ..services.model_registry import get_model_topology

    return await get_model_topology()


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
async def costs_by_model(_user: UserInfo = Depends(get_current_user)):
    return {"models": await get_cost_by_model(), "period": "7d"}


@router.get("/costs/by-role")
async def costs_by_role(
    _user: UserInfo = Depends(get_current_user),
    days: int = Query(7, ge=1, le=90),
):
    """Per-role cost breakdown from trace LLM calls via full_record JSONB."""

    cutoff = time.time() - days * 86400
    try:
        async with async_session() as session:
            result = await session.execute(
                text(  # nosemgrep
                    """SELECT trace_id, full_record FROM traces WHERE timestamp >= :cutoff"""
                ),
                {"cutoff": cutoff},
            )
            rows = result.all()

        role_agg: dict[str, dict] = {}
        for row in rows:
            full = row[1] or {}
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
                            "cost_usd": 0.0,
                        }
                    agg = role_agg[role]
                    agg["prompt_tokens"] += call.get("prompt_tokens", 0)
                    agg["completion_tokens"] += call.get("completion_tokens", 0)
                    agg["requests"] += 1

        cost_rates = await get_cost_estimates()
        pricing: dict[str, tuple[float, float]] = {}
        for c in cost_rates:
            pricing[c.get("role", "")] = (c["input_per_million"], c["output_per_million"])

        for role, agg in role_agg.items():
            rates = pricing.get(role, (0, 0))
            agg["cost_usd"] = round(
                (agg["prompt_tokens"] / 1_000_000) * rates[0] + (agg["completion_tokens"] / 1_000_000) * rates[1],
                6,
            )

        return {
            "roles": sorted(role_agg.values(), key=lambda x: x["cost_usd"], reverse=True),
            "period_days": days,
        }
    except Exception:
        logger.warning("costs_by_role_failed", exc_info=True)
        return {"roles": [], "period_days": days}


def _infer_role(node_name: str, model_name: str) -> str:
    """Map node/model names to logical roles."""
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
    """Per-day cost rollup directly from trace token counts and estimated_cost_usd."""
    cutoff = time.time() - days * 86400
    try:
        async with async_session() as session:
            result = await session.execute(
                text(  # nosemgrep
                    """
                    SELECT
                        DATE(to_timestamp(timestamp)) AS day,
                        SUM(total_tokens)::bigint AS tokens,
                        COUNT(*)::int AS requests,
                        SUM(estimated_cost_usd) AS cost_usd
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
                        "cost_usd": round(float(r.cost_usd or 0), 6),
                    }
                    for r in rows
                ],
                "period_days": days,
            }
    except Exception:
        logger.warning("costs_daily_failed", exc_info=True)
        return {"daily": [], "period_days": days}


@router.get("/performance")
async def model_performance(_user: UserInfo = Depends(get_current_user)):
    models = await prom.get_model_performance()
    return {"models": models, "period": "24h"}
