"""Model registry, deployments, cost, and performance endpoints."""

import logging
import os
import time
from datetime import UTC, datetime
from datetime import date as date_type

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import text

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..services import prometheus_client_svc as prom
from ..services.model_registry import (
    assign_role,
    create_deployment,
    deactivate_role,
    delete_deployment,
    get_cost_by_model,
    get_cost_estimates,
    get_model_deployments,
    get_role_assignments,
    get_role_history,
    seed_model_deployments,
    set_deployment_active,
    update_deployment,
    upsert_model_cost,
)
from ..services.provider_catalog import KNOWN_ROLES
from ..services.admin_audit import record_admin_audit
from ..services.token_cost import estimate_llm_call_cost_usd

logger = logging.getLogger("synesis.admin.models_router")
router = APIRouter(prefix="/api/v1/models", tags=["models"])


# ---------------------------------------------------------------------------
# Registry snapshot (same data as GET /roles; optional alias for older clients)
# ---------------------------------------------------------------------------

@router.get("/")
async def list_models(_user: UserInfo = Depends(get_current_user)):
    return {"roles": await get_role_assignments()}


@router.get("/topology")
async def model_topology(_user: UserInfo = Depends(get_current_user)):
    from ..services.model_registry import get_model_topology

    return await get_model_topology()


@router.get("/pipeline-services")
async def pipeline_services(_user: UserInfo = Depends(get_current_user)):
    """Operational visibility for ingestion-adjacent model/services."""
    targets = [
        ("router_model", os.getenv("SYNESIS_ROUTER_MODEL_URL", "")),
        ("planner_model", os.getenv("SYNESIS_PLANNER_MODEL_URL", "")),
        ("general_model", os.getenv("SYNESIS_GENERAL_MODEL_URL", "")),
        ("critic_model", os.getenv("SYNESIS_CRITIC_MODEL_URL", "")),
        ("coder_model", os.getenv("SYNESIS_CODER_MODEL_URL", "")),
        ("embedder", os.getenv("SYNESIS_EMBEDDER_URL", "")),
        ("keyword_service", os.getenv("SYNESIS_KEYWORD_SERVICE_URL", "")),
        ("spam_service", os.getenv("SYNESIS_SPAM_SERVICE_URL", "")),
        ("preprocess_service", os.getenv("SYNESIS_PREPROCESS_SERVICE_URL", "")),
    ]
    rows: list[dict] = []
    async with httpx.AsyncClient(timeout=3.0) as client:
        for name, raw_url in targets:
            url = (raw_url or "").strip()
            if not url:
                rows.append({
                    "name": name,
                    "url": "",
                    "configured": False,
                    "reachable": False,
                    "status_code": None,
                    "latency_ms": None,
                    "error": "not_configured",
                })
                continue
            health_url = url.rstrip("/") + "/health"
            started = time.time()
            try:
                resp = await client.get(health_url)
                rows.append({
                    "name": name,
                    "url": url,
                    "configured": True,
                    "reachable": 200 <= resp.status_code < 500,
                    "status_code": resp.status_code,
                    "latency_ms": int((time.time() - started) * 1000),
                    "error": "",
                })
            except Exception as exc:
                rows.append({
                    "name": name,
                    "url": url,
                    "configured": True,
                    "reachable": False,
                    "status_code": None,
                    "latency_ms": None,
                    "error": str(exc)[:180],
                })
    return {"services": rows}


# ---------------------------------------------------------------------------
# Role-first model registry (primary API)
# ---------------------------------------------------------------------------

@router.get("/roles")
async def list_role_assignments(_user: UserInfo = Depends(get_current_user)):
    """Active model assignment per canonical role."""
    return {"roles": await get_role_assignments()}


@router.put("/roles/{role}")
async def assign_model_to_role(
    role: str,
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    """Assign a provider + model to a role.  Deactivates the previous assignment."""
    from ..services.model_reconciler import reconcile

    if role not in KNOWN_ROLES:
        raise HTTPException(400, f"Unknown role: {role}. Valid: {', '.join(KNOWN_ROLES)}")
    if not data.get("provider") or not data.get("model"):
        raise HTTPException(400, "provider and model are required")

    try:
        result = await assign_role(
            role,
            data["provider"],
            data["model"],
            endpoint=data.get("endpoint", ""),
            api_key_env=data.get("api_key_env", ""),
            max_tokens=data.get("max_tokens", 8192),
            temperature=data.get("temperature", 0.1),
            fallbacks=data.get("fallbacks"),
            description=data.get("description", ""),
            notes=data.get("notes", ""),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None

    rec_err: str | None = None
    rec_sum: dict | None = None
    try:
        rec_sum = await reconcile()
    except Exception as exc:
        rec_err = repr(exc)
        logger.warning("reconcile_after_role_assign_failed role=%s", role, exc_info=True)

    await record_admin_audit(
        user=_user,
        action="models.role_assign",
        status="success" if rec_err is None else "partial",
        summary=(
            f"Assigned {role} → {data['provider']}/{data['model']}"
            + ("; LiteLLM reconcile failed" if rec_err else "; LiteLLM reconcile completed")
        ),
        detail={
            "role": role,
            "provider": data["provider"],
            "model": data["model"],
            "assignment": result,
            "reconcile": rec_sum,
            "reconcile_error": rec_err,
        },
    )
    return result


@router.delete("/roles/{role}")
async def remove_role_assignment(
    role: str,
    _user: UserInfo = Depends(get_current_user),
):
    """Deactivate the model assignment for a role."""
    from ..services.model_reconciler import reconcile

    if role not in KNOWN_ROLES:
        raise HTTPException(400, f"Unknown role: {role}")
    result = await deactivate_role(role)
    if result is None:
        raise HTTPException(404, f"No active assignment for role: {role}")
    rec_err: str | None = None
    rec_sum: dict | None = None
    try:
        rec_sum = await reconcile()
    except Exception as exc:
        rec_err = repr(exc)
        logger.warning("reconcile_after_role_deactivate_failed role=%s", role, exc_info=True)
    await record_admin_audit(
        user=_user,
        action="models.role_deactivate",
        status="success" if rec_err is None else "partial",
        summary=(
            f"Deactivated assignment for {role}"
            + ("; LiteLLM reconcile failed" if rec_err else "; LiteLLM reconcile completed")
        ),
        detail={"role": role, "previous": result, "reconcile": rec_sum, "reconcile_error": rec_err},
    )
    return result


@router.get("/roles/{role}/history")
async def role_history(
    role: str,
    _user: UserInfo = Depends(get_current_user),
    days: int = Query(90, ge=1, le=365),
):
    """Historical model assignments for a role."""
    return {"history": await get_role_history(role, days=days)}


# ---------------------------------------------------------------------------
# DB model deployments CRUD (advanced; prefer PUT /roles/{role})
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
    if not data.get("role"):
        raise HTTPException(400, "role is required")
    out = await create_deployment(data)
    await record_admin_audit(
        user=_user,
        action="models.deployment_create",
        status="success",
        summary=f"Created deployment role={out.get('role')} id={out.get('id')}",
        detail={"deployment": out},
    )
    return out


@router.put("/deployments/{deployment_id}")
async def update_model_deployment(
    deployment_id: int,
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    from ..services.model_reconciler import reconcile

    result = await update_deployment(deployment_id, data)
    if result is None:
        raise HTTPException(404, "deployment not found")
    rec_err: str | None = None
    rec_sum: dict | None = None
    if any(
        k in data
        for k in ("litellm_params", "is_active", "served_name", "fallbacks")
    ):
        try:
            rec_sum = await reconcile()
        except Exception as exc:
            rec_err = repr(exc)
            logger.warning("reconcile_after_deployment_update_failed id=%d", deployment_id, exc_info=True)
    await record_admin_audit(
        user=_user,
        action="models.deployment_update",
        status="success" if rec_err is None else "partial",
        summary=(
            f"Updated deployment id={deployment_id}"
            + (
                ""
                if rec_sum is None and rec_err is None
                else ("; LiteLLM reconcile failed" if rec_err else "; LiteLLM reconcile completed")
            )
        ),
        detail={
            "deployment_id": deployment_id,
            "patch_keys": list(data.keys()),
            "reconcile": rec_sum,
            "reconcile_error": rec_err,
        },
    )
    return result


@router.delete("/deployments/{deployment_id}")
async def delete_model_deployment(
    deployment_id: int,
    _user: UserInfo = Depends(get_current_user),
):

    ok = await delete_deployment(deployment_id)
    if not ok:
        raise HTTPException(404, "deployment not found")
    await record_admin_audit(
        user=_user,
        action="models.deployment_delete",
        status="success",
        summary=f"Deleted deployment id={deployment_id}",
        detail={"deployment_id": deployment_id},
    )
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
    rec_ok = True
    rec_err: str | None = None
    try:
        rec_ok = await reconcile_single(deployment_id)
    except Exception as exc:
        rec_err = repr(exc)
        rec_ok = False
        logger.warning("reconcile_after_activate_failed id=%d", deployment_id, exc_info=True)
    await record_admin_audit(
        user=_user,
        action="models.deployment_activate",
        status="success" if rec_ok and not rec_err else "partial",
        summary=(
            f"Activated deployment {deployment_id} ({result.get('served_name', '')})"
            + ("; reconcile_single failed" if rec_err or not rec_ok else "; LiteLLM sync ok")
        ),
        detail={"deployment_id": deployment_id, "deployment": result, "reconcile_ok": rec_ok, "error": rec_err},
    )
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
    rec_ok = True
    rec_err: str | None = None
    try:
        rec_ok = await reconcile_single(deployment_id)
    except Exception as exc:
        rec_err = repr(exc)
        rec_ok = False
        logger.warning("reconcile_after_deactivate_failed id=%d", deployment_id, exc_info=True)
    await record_admin_audit(
        user=_user,
        action="models.deployment_deactivate",
        status="success" if rec_ok and not rec_err else "partial",
        summary=(
            f"Deactivated deployment {deployment_id}"
            + ("; reconcile_single failed" if rec_err or not rec_ok else "; LiteLLM sync ok")
        ),
        detail={"deployment_id": deployment_id, "deployment": result, "reconcile_ok": rec_ok, "error": rec_err},
    )
    return result


@router.post("/sync-from-yaml")
async def sync_from_yaml(_user: UserInfo = Depends(get_current_user)):
    from ..services.model_registry import invalidate_yaml_cache

    invalidate_yaml_cache()
    count = await seed_model_deployments(force=True)
    await record_admin_audit(
        user=_user,
        action="models.sync_from_yaml",
        status="success",
        summary=f"Re-seeded model_deployments from models.yaml ({count} rows)",
        detail={"seeded": count},
    )
    return {
        "seeded": count,
        "warning": (
            "Re-seeding from models.yaml clears and replaces model_deployments rows from the mounted file. "
            "For ongoing changes, use Registry role assignments instead."
        ),
    }


@router.post("/reconcile")
async def trigger_reconcile(_user: UserInfo = Depends(get_current_user)):
    from ..services.model_reconciler import reconcile

    err: str | None = None
    summary: dict | None = None
    try:
        summary = await reconcile()
    except Exception as exc:
        err = repr(exc)
        logger.warning("manual_reconcile_failed", exc_info=True)
    await record_admin_audit(
        user=_user,
        action="models.reconcile.manual",
        status="success" if err is None else "error",
        summary=(
            "Manual LiteLLM reconcile"
            if err is None
            else "Manual LiteLLM reconcile failed"
        ),
        detail={"reconcile": summary, "error": err},
    )
    if err is not None:
        raise HTTPException(502, f"Reconcile failed: {err}")
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

    rec_err: str | None = None
    rec_sum: dict | None = None
    try:
        rec_sum = await reconcile()
    except Exception as exc:
        rec_err = repr(exc)
        logger.warning("reconcile_after_fallback_update_failed id=%d", deployment_id, exc_info=True)
    await record_admin_audit(
        user=_user,
        action="models.fallbacks_update",
        status="success" if rec_err is None else "partial",
        summary=f"Updated fallbacks for deployment {deployment_id}",
        detail={
            "deployment_id": deployment_id,
            "fallbacks": fallbacks,
            "reconcile": rec_sum,
            "reconcile_error": rec_err,
        },
    )
    return result


# ---------------------------------------------------------------------------
# Costs
# ---------------------------------------------------------------------------

@router.get("/costs/active")
async def active_costs(_user: UserInfo = Depends(get_current_user)):
    """Rate configuration for active role assignments only.

    For each active role, resolves pricing from: manual DB overrides,
    LiteLLM proxy data, bundled API pricing, or infra cost calculator.
    """
    from ..services.infra_pricing import get_infra_config_for_role
    from ..services.pricing_lookup import resolve_pricing

    assignments = await get_role_assignments()
    costs = await get_cost_estimates()
    cost_by_role: dict[str, dict] = {c["role"]: c for c in costs}

    result = []
    for a in assignments:
        if not a.get("assigned"):
            continue
        role = a["role"]
        provider = a.get("provider", "")
        model = a.get("model", "")
        served_name = a.get("served_name", "")

        # Manual DB overrides (rates only); model/provider always from registry assignment.
        manual = cost_by_role.get(role)
        if manual and (manual.get("input_per_million", 0) > 0 or manual.get("output_per_million", 0) > 0):
            result.append({
                "role": role,
                "model": model,
                "profile": "",
                "source": manual.get("source", provider),
                "provider": provider,
                "input_per_million": manual["input_per_million"],
                "input_cached_per_million": manual.get("input_cached_per_million"),
                "output_per_million": manual["output_per_million"],
                "monthly_fixed_cost": manual.get("monthly_fixed_cost", 0.0),
                "cost_formula": manual.get("cost_formula", ""),
                "notes": manual.get("notes", ""),
                "pricing_source": "manual",
            })
            continue

        # For local providers, check infra cost calculator.
        if provider in ("vllm", "kserve"):
            infra = await get_infra_config_for_role(role)
            if infra and infra.get("input_per_million", 0) > 0:
                result.append({
                    "role": role, "model": model, "profile": "",
                    "source": provider, "provider": provider,
                    "input_per_million": infra["input_per_million"],
                    "output_per_million": infra["output_per_million"],
                    "monthly_fixed_cost": infra.get("hourly_rate", 0) * 730,
                    "cost_formula": f"{infra.get('cloud', '')} {infra.get('instance_type', '')} @ ${infra.get('hourly_rate', 0):.2f}/hr",
                    "notes": infra.get("notes", ""),
                    "pricing_source": "infra_calc",
                })
                continue

        # For API providers, try auto-lookup.
        pricing = await resolve_pricing(provider, model, served_name)
        if pricing:
            rates, source = pricing
            result.append({
                "role": role, "model": model, "profile": "",
                "source": provider, "provider": provider,
                "input_per_million": rates[0],
                "output_per_million": rates[1],
                "monthly_fixed_cost": 0.0,
                "cost_formula": "",
                "notes": f"auto: {source}",
                "pricing_source": source,
            })
            continue

        # Fallback: zero rates.
        result.append({
            "role": role, "model": model, "profile": "",
            "source": provider, "provider": provider,
            "input_per_million": 0.0,
            "output_per_million": 0.0,
            "monthly_fixed_cost": 0.0,
            "cost_formula": "",
            "notes": "",
            "pricing_source": "unknown",
        })

    return {"roles": result}


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
    await record_admin_audit(
        user=_user,
        action="models.cost_update",
        status="success",
        summary=f"Updated cost rates for role={result.get('role', data.get('role'))}",
        detail={"cost": result},
    )
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
                            "cached_prompt_tokens": 0,
                            "requests": 0,
                            "estimated_cost_usd": 0.0,
                            "actual_cost_usd": 0.0,
                        }
                    agg = model_agg[model]
                    agg["prompt_tokens"] += call.get("prompt_tokens", 0)
                    agg["completion_tokens"] += call.get("completion_tokens", 0)
                    agg["cached_prompt_tokens"] += call.get("cached_prompt_tokens", 0)
                    agg["requests"] += 1
                    agg["actual_cost_usd"] += float(call.get("actual_cost", 0.0) or 0.0)

        cost_rates = await get_cost_estimates()
        pricing_by_role: dict[str, tuple[float, float, float | None]] = {
            c.get("role", ""): (
                c["input_per_million"],
                c["output_per_million"],
                c.get("input_cached_per_million"),
            )
            for c in cost_rates
        }

        def _role_for_model(target: str) -> str:
            for row in rows:
                full = row[0] or {}
                for span in full.get("spans", []):
                    node = span.get("node_name", "unknown")
                    for call in span.get("llm_calls", []):
                        if call.get("model", "unknown") == target:
                            return _infer_role(node, call.get("model", ""))
            return "unknown"

        for model, agg in model_agg.items():
            role = _role_for_model(model)
            inp_r, out_r, ic_r = pricing_by_role.get(role, (0.0, 0.0, None))
            agg["estimated_cost_usd"] = estimate_llm_call_cost_usd(
                agg["prompt_tokens"],
                agg["completion_tokens"],
                agg["cached_prompt_tokens"],
                input_per_million=inp_r,
                output_per_million=out_r,
                input_cached_per_million=ic_r,
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
                            "cached_prompt_tokens": 0,
                            "requests": 0,
                            "estimated_cost_usd": 0.0,
                            "actual_cost_usd": 0.0,
                        }
                    agg = role_agg[role]
                    agg["prompt_tokens"] += call.get("prompt_tokens", 0)
                    agg["completion_tokens"] += call.get("completion_tokens", 0)
                    agg["cached_prompt_tokens"] += call.get("cached_prompt_tokens", 0)
                    agg["requests"] += 1
                    agg["actual_cost_usd"] += float(call.get("actual_cost", 0.0) or 0.0)

        cost_rates = await get_cost_estimates()
        pricing: dict[str, tuple[float, float, float | None]] = {}
        for c in cost_rates:
            pricing[c.get("role", "")] = (
                c["input_per_million"],
                c["output_per_million"],
                c.get("input_cached_per_million"),
            )

        for role, agg in role_agg.items():
            inp_r, out_r, ic_r = pricing.get(role, (0.0, 0.0, None))
            agg["estimated_cost_usd"] = estimate_llm_call_cost_usd(
                agg["prompt_tokens"],
                agg["completion_tokens"],
                agg["cached_prompt_tokens"],
                input_per_million=inp_r,
                output_per_million=out_r,
                input_cached_per_million=ic_r,
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
    if "summarizer" in node_lower or "summar" in node_lower or "synesis-summarizer" in model_lower:
        return "summarizer"
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
    cutoff = datetime.now(UTC).timestamp() - days * 86400
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
                            "total_cached_prompt_tokens": 0,
                            "total_actual_cost": 0.0,
                        }
                    ms = model_stats[model]
                    lat = call.get("latency_ms", 0)
                    ms["request_count"] += 1
                    ms["latencies"].append(lat)
                    ms["total_tokens"] += call.get("total_tokens", 0)
                    ms["total_prompt_tokens"] += call.get("prompt_tokens", 0)
                    ms["total_completion_tokens"] += call.get("completion_tokens", 0)
                    ms["total_cached_prompt_tokens"] += call.get("cached_prompt_tokens", 0)
                    ms["total_actual_cost"] += float(call.get("actual_cost", 0.0) or 0.0)

        results = []
        for ms in model_stats.values():
            lats = sorted(ms.pop("latencies"))
            n = len(lats)
            avg_lat = sum(lats) / n if n else 0
            p95_idx = int(n * 0.95) if n else 0
            p95_lat = lats[min(p95_idx, n - 1)] if n else 0
            tp = ms["total_prompt_tokens"]
            tc = ms["total_cached_prompt_tokens"]
            ms["cache_hit_rate"] = round(tc / tp, 4) if tp > 0 else 0.0
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


# ---------------------------------------------------------------------------
# Performance by role
# ---------------------------------------------------------------------------

@router.get("/performance/by-role")
async def performance_by_role(
    _user: UserInfo = Depends(get_current_user),
    days: int = Query(7, ge=1, le=90),
):
    """Per-role performance metrics aggregated from trace LLM calls."""
    cutoff = time.time() - days * 86400
    try:
        async with async_session() as session:
            result = await session.execute(
                text("SELECT full_record FROM traces WHERE timestamp >= :cutoff"),
                {"cutoff": cutoff},
            )
            rows = result.all()

        role_stats: dict[str, dict] = {}
        for row in rows:
            full = row[0] or {}
            for span in full.get("spans", []):
                node = span.get("node_name", "unknown")
                for call in span.get("llm_calls", []):
                    role = _infer_role(node, call.get("model", ""))
                    if role not in role_stats:
                        role_stats[role] = {
                            "role": role,
                            "request_count": 0,
                            "latencies": [],
                            "total_tokens": 0,
                            "total_prompt_tokens": 0,
                            "total_cached_prompt_tokens": 0,
                            "total_actual_cost": 0.0,
                        }
                    rs = role_stats[role]
                    rs["request_count"] += 1
                    rs["latencies"].append(call.get("latency_ms", 0))
                    rs["total_tokens"] += call.get("total_tokens", 0)
                    rs["total_prompt_tokens"] += call.get("prompt_tokens", 0)
                    rs["total_cached_prompt_tokens"] += call.get("cached_prompt_tokens", 0)
                    rs["total_actual_cost"] += float(call.get("actual_cost", 0.0) or 0.0)

        assignments = await get_role_assignments()
        reg_by_role = {a["role"]: a for a in assignments}

        results = []
        for role in KNOWN_ROLES:
            rs = role_stats.get(role)
            if rs is None:
                rs = {
                    "role": role,
                    "request_count": 0,
                    "latencies": [],
                    "total_tokens": 0,
                    "total_prompt_tokens": 0,
                    "total_cached_prompt_tokens": 0,
                    "total_actual_cost": 0.0,
                }
            lats = sorted(rs.pop("latencies"))
            n = len(lats)
            avg_lat = sum(lats) / n if n else 0
            p95_idx = int(n * 0.95) if n else 0
            tp = rs.get("total_prompt_tokens", 0)
            tc = rs.get("total_cached_prompt_tokens", 0)
            cache_hit = round(tc / tp, 4) if tp > 0 else 0.0
            a = reg_by_role.get(role, {})
            results.append({
                **rs,
                "cache_hit_rate": cache_hit,
                "avg_latency_ms": round(avg_lat, 1),
                "p95_latency_ms": round(lats[min(p95_idx, n - 1)] if n else 0, 1),
                "total_actual_cost": round(rs["total_actual_cost"], 6),
                "registry_model": a.get("model", ""),
                "registry_provider": a.get("provider", ""),
                "served_name": a.get("served_name", f"synesis-{role}"),
                "assigned": bool(a.get("assigned")),
            })

        return {"roles": results, "period_days": days}

    except Exception:
        logger.warning("performance_by_role_failed", exc_info=True)
        return {"roles": [], "period_days": days}
