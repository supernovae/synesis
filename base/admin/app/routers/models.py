"""Model registry, deployments, cost, and performance endpoints."""

import logging
import os
import time
from datetime import date as date_type
from typing import Any

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select, text

from ..auth import UserInfo
from ..db.engine import async_session
from ..db.models import ModelPolicy, Trace
from ..deps import PLANNER_URL
from ..internal_auth import ServicePrincipal, require_service_or_platform_admin
from ..rbac import Role, require_org_admin, require_platform_admin, resolve_role, trace_scope_filters
from ..services import prometheus_client_svc as prom
from ..services import public_model_offerings as public_offerings_svc
from ..services.admin_audit import record_admin_audit
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
    set_deployment_active,
    update_deployment,
    upsert_model_cost,
)
from ..services.prompt_library import (
    create_prompt_profile,
    delete_prompt_assignment,
    delete_prompt_profile,
    get_prompt_snapshot,
    list_prompt_assignments,
    list_prompt_profiles,
    update_prompt_profile,
    upsert_prompt_assignment,
)
from ..services.provider_catalog import KNOWN_ROLES
from ..services.token_cost import (
    estimate_llm_call_cost_from_payload,
    parse_recorded_estimated_cost,
)

logger = logging.getLogger("synesis.admin.models_router")
router = APIRouter(prefix="/api/v1/models", tags=["models"])


def _registry_runtime_summary() -> dict[str, Any]:
    return {"source_of_truth": "admin_db", "runtime": "direct_provider_routes", "route_refresh_required": False}


# ---------------------------------------------------------------------------
# Registry snapshot (same data as GET /roles; optional alias for older clients)
# ---------------------------------------------------------------------------


@router.get("/")
async def list_models(_user: UserInfo = Depends(require_org_admin)):
    return {"roles": await get_role_assignments()}


@router.get("/topology")
async def model_topology(_user: UserInfo = Depends(require_org_admin)):
    from ..services.model_registry import get_model_topology

    return await get_model_topology()


@router.get("/pipeline-services")
async def pipeline_services(_user: UserInfo = Depends(require_org_admin)):
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
                rows.append(
                    {
                        "name": name,
                        "url": "",
                        "configured": False,
                        "reachable": False,
                        "status_code": None,
                        "latency_ms": None,
                        "error": "not_configured",
                    }
                )
                continue
            health_url = url.rstrip("/") + "/health"
            started = time.time()
            try:
                resp = await client.get(health_url)
                rows.append(
                    {
                        "name": name,
                        "url": url,
                        "configured": True,
                        "reachable": 200 <= resp.status_code < 500,
                        "status_code": resp.status_code,
                        "latency_ms": int((time.time() - started) * 1000),
                        "error": "",
                    }
                )
            except Exception:
                logger.warning("pipeline_service_probe_failed service=%s", name, exc_info=True)
                rows.append(
                    {
                        "name": name,
                        "url": url,
                        "configured": True,
                        "reachable": False,
                        "status_code": None,
                        "latency_ms": None,
                        "error": "probe_failed",
                    }
                )
    return {"services": rows}


# ---------------------------------------------------------------------------
# Role-first model registry (primary API)
# ---------------------------------------------------------------------------


@router.get("/roles")
async def list_role_assignments(_user: UserInfo = Depends(require_org_admin)):
    """Active model assignment per canonical role."""
    return {"roles": await get_role_assignments()}


@router.get("/roles/internal")
async def list_role_assignments_internal(
    _principal: ServicePrincipal | UserInfo = Depends(require_service_or_platform_admin),
):
    """Internal service read path for role assignments (Yarn tier polling)."""
    return {"roles": await get_role_assignments()}


class PublicOfferingCreate(BaseModel):
    client_model_id: str
    label: str | None = None
    effort_tier: str | None = None
    connection_mode: str | None = None
    route_via_role: str | None = None
    standalone_provider: str | None = None
    standalone_endpoint: str | None = None
    standalone_api_key_env: str | None = None
    backend_model_override: str | None = None
    generation_params: dict[str, Any] | None = None
    expose_planner: bool = False
    expose_yarn: bool = False
    is_active: bool = True


class PublicOfferingPatch(BaseModel):
    client_model_id: str | None = None
    label: str | None = None
    effort_tier: str | None = None
    connection_mode: str | None = None
    route_via_role: str | None = None
    standalone_provider: str | None = None
    standalone_endpoint: str | None = None
    standalone_api_key_env: str | None = None
    backend_model_override: str | None = None
    generation_params: dict[str, Any] | None = None
    expose_planner: bool | None = None
    expose_yarn: bool | None = None
    is_active: bool | None = None


@router.get("/public-offerings")
async def list_public_offerings(_user: UserInfo = Depends(require_org_admin)):
    async with async_session() as session:
        rows = await public_offerings_svc.list_offerings(session)
    return {"offerings": rows}


@router.get("/public-offerings/internal")
async def list_public_offerings_internal(
    for_service: str = Query("yarn"),
    _principal: ServicePrincipal | UserInfo = Depends(require_service_or_platform_admin),
):
    if for_service not in ("yarn", "planner"):
        raise HTTPException(400, "for_service must be 'yarn' or 'planner'")
    async with async_session() as session:
        rows = await public_offerings_svc.list_offerings_for_service(session, for_service=for_service)
    return {"offerings": rows, "for_service": for_service}


@router.post("/public-offerings")
async def create_public_offering(
    body: PublicOfferingCreate,
    user: UserInfo = Depends(require_platform_admin),
):
    try:
        async with async_session() as session:
            row = await public_offerings_svc.create_offering(
                session,
                client_model_id=body.client_model_id,
                label=body.label,
                effort_tier=body.effort_tier,
                connection_mode=body.connection_mode,
                route_via_role=body.route_via_role,
                standalone_provider=body.standalone_provider,
                standalone_endpoint=body.standalone_endpoint,
                standalone_api_key_env=body.standalone_api_key_env,
                backend_model_override=body.backend_model_override,
                generation_params=body.generation_params,
                expose_planner=body.expose_planner,
                expose_yarn=body.expose_yarn,
                is_active=body.is_active,
            )
            await session.commit()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    await record_admin_audit(
        user=user,
        action="models.public_offering_create",
        status="success",
        summary=f"Created public offering {row.get('client_model_id', '')}",
        detail={"offering": row},
    )
    return row


@router.patch("/public-offerings/{offering_id}")
async def patch_public_offering(
    offering_id: int,
    body: PublicOfferingPatch,
    user: UserInfo = Depends(require_platform_admin),
):
    patch = body.model_dump(exclude_unset=True)
    if not patch:
        raise HTTPException(400, "no fields to update")
    try:
        async with async_session() as session:
            row = await public_offerings_svc.update_offering(session, offering_id, patch)
            if row is None:
                raise HTTPException(404, "public offering not found")
            await session.commit()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    await record_admin_audit(
        user=user,
        action="models.public_offering_update",
        status="success",
        summary=f"Updated public offering id={offering_id}",
        detail={"offering_id": offering_id, "patch": patch},
    )
    return row


@router.delete("/public-offerings/{offering_id}")
async def delete_public_offering(
    offering_id: int,
    user: UserInfo = Depends(require_platform_admin),
):
    async with async_session() as session:
        ok = await public_offerings_svc.delete_offering(session, offering_id)
        if not ok:
            raise HTTPException(404, "public offering not found")
        await session.commit()
    await record_admin_audit(
        user=user,
        action="models.public_offering_delete",
        status="success",
        summary=f"Deleted public offering id={offering_id}",
        detail={"offering_id": offering_id},
    )
    return {"ok": True, "id": offering_id}


@router.get("/prompts/profiles")
async def list_prompts_profiles(
    service: str | None = Query(None),
    _user: UserInfo = Depends(require_org_admin),
):
    return {"profiles": await list_prompt_profiles(service=service)}


@router.post("/prompts/profiles")
async def create_prompts_profile(
    data: dict = Body(...),
    user: UserInfo = Depends(require_platform_admin),
):
    try:
        out = await create_prompt_profile(data, actor=user.email or user.username)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    await record_admin_audit(
        user=user,
        action="models.prompt_profile_create",
        status="success",
        summary=f"Created prompt profile {out.get('name', '')}",
        detail={"profile": out},
    )
    return out


@router.put("/prompts/profiles/{profile_id}")
async def update_prompts_profile(
    profile_id: int,
    data: dict = Body(...),
    user: UserInfo = Depends(require_platform_admin),
):
    try:
        out = await update_prompt_profile(profile_id, data, actor=user.email or user.username)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    if out is None:
        raise HTTPException(404, "prompt profile not found")
    await record_admin_audit(
        user=user,
        action="models.prompt_profile_update",
        status="success",
        summary=f"Updated prompt profile id={profile_id}",
        detail={"profile_id": profile_id, "patch_keys": list(data.keys())},
    )
    return out


@router.delete("/prompts/profiles/{profile_id}")
async def delete_prompts_profile(
    profile_id: int,
    user: UserInfo = Depends(require_platform_admin),
):
    ok = await delete_prompt_profile(profile_id)
    if not ok:
        raise HTTPException(404, "prompt profile not found")
    await record_admin_audit(
        user=user,
        action="models.prompt_profile_delete",
        status="success",
        summary=f"Deleted prompt profile id={profile_id}",
        detail={"profile_id": profile_id},
    )
    return {"deleted": profile_id}


@router.get("/prompts/assignments")
async def list_prompts_assignments(
    service: str | None = Query(None),
    _user: UserInfo = Depends(require_org_admin),
):
    return {"assignments": await list_prompt_assignments(service=service)}


@router.put("/prompts/assignments")
async def put_prompts_assignment(
    data: dict = Body(...),
    user: UserInfo = Depends(require_platform_admin),
):
    try:
        out = await upsert_prompt_assignment(data, actor=user.email or user.username)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    await record_admin_audit(
        user=user,
        action="models.prompt_assignment_upsert",
        status="success",
        summary=(
            f"Assigned prompt service={out.get('service', '')} "
            f"{out.get('target_type', '')}:{out.get('target_value', '')} -> profile={out.get('profile_id', '')}"
        ),
        detail={"assignment": out},
    )
    return out


@router.delete("/prompts/assignments/{assignment_id}")
async def delete_prompts_assignment(
    assignment_id: int,
    user: UserInfo = Depends(require_platform_admin),
):
    ok = await delete_prompt_assignment(assignment_id)
    if not ok:
        raise HTTPException(404, "prompt assignment not found")
    await record_admin_audit(
        user=user,
        action="models.prompt_assignment_delete",
        status="success",
        summary=f"Deleted prompt assignment id={assignment_id}",
        detail={"assignment_id": assignment_id},
    )
    return {"deleted": assignment_id}


@router.get("/prompts/internal/{service}")
async def prompts_snapshot_internal(
    service: str,
    _principal: ServicePrincipal | UserInfo = Depends(require_service_or_platform_admin),
):
    try:
        return await get_prompt_snapshot(service)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@router.put("/roles/{role}")
async def assign_model_to_role(
    role: str,
    data: dict = Body(...),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Assign a provider + model to a role.  Deactivates the previous assignment."""
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
            temperature=data.get("temperature", 0.3),
            top_p=data.get("top_p"),
            top_k=data.get("top_k"),
            min_p=data.get("min_p"),
            presence_penalty=data.get("presence_penalty"),
            repetition_penalty=data.get("repetition_penalty"),
            enable_thinking=data.get("enable_thinking"),
            reasoning_effort=data.get("reasoning_effort"),
            fallbacks=data.get("fallbacks"),
            adapter_hint=data.get("adapter_hint"),
            context_window=data.get("context_window"),
            description=data.get("description", ""),
            notes=data.get("notes", ""),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None

    await record_admin_audit(
        user=_user,
        action="models.role_assign",
        status="success",
        summary=f"Assigned {role} → {data['provider']}/{data['model']}; direct routes update from admin registry",
        detail={
            "role": role,
            "provider": data["provider"],
            "model": data["model"],
            "assignment": result,
            "runtime": _registry_runtime_summary(),
        },
    )
    return result


@router.delete("/roles/{role}")
async def remove_role_assignment(
    role: str,
    _user: UserInfo = Depends(require_platform_admin),
):
    """Deactivate the model assignment for a role."""
    if role not in KNOWN_ROLES:
        raise HTTPException(400, f"Unknown role: {role}")
    result = await deactivate_role(role)
    if result is None:
        raise HTTPException(404, f"No active assignment for role: {role}")
    await record_admin_audit(
        user=_user,
        action="models.role_deactivate",
        status="success",
        summary=f"Deactivated assignment for {role}; direct routes update from admin registry",
        detail={"role": role, "previous": result, "runtime": _registry_runtime_summary()},
    )
    return result


@router.get("/roles/{role}/history")
async def role_history(
    role: str,
    _user: UserInfo = Depends(require_org_admin),
    days: int = Query(90, ge=1, le=365),
):
    """Historical model assignments for a role."""
    return {"history": await get_role_history(role, days=days)}


# ---------------------------------------------------------------------------
# DB model deployments CRUD (advanced; prefer PUT /roles/{role})
# ---------------------------------------------------------------------------


@router.get("/deployments")
async def list_deployments(_user: UserInfo = Depends(require_org_admin)):
    deployments = await get_model_deployments()
    return {"deployments": deployments}


@router.post("/deployments")
async def create_model_deployment(
    data: dict = Body(...),
    _user: UserInfo = Depends(require_platform_admin),
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
    _user: UserInfo = Depends(require_platform_admin),
):
    result = await update_deployment(deployment_id, data)
    if result is None:
        raise HTTPException(404, "deployment not found")
    await record_admin_audit(
        user=_user,
        action="models.deployment_update",
        status="success",
        summary=f"Updated deployment id={deployment_id}; direct routes update from admin registry",
        detail={
            "deployment_id": deployment_id,
            "patch_keys": list(data.keys()),
            "runtime": _registry_runtime_summary(),
        },
    )
    return result


@router.delete("/deployments/{deployment_id}")
async def delete_model_deployment(
    deployment_id: int,
    _user: UserInfo = Depends(require_platform_admin),
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
    _user: UserInfo = Depends(require_platform_admin),
):
    result = await set_deployment_active(deployment_id, True)
    if result is None:
        raise HTTPException(404, "deployment not found")
    await record_admin_audit(
        user=_user,
        action="models.deployment_activate",
        status="success",
        summary=f"Activated deployment {deployment_id} ({result.get('served_name', '')}); direct routes update from admin registry",
        detail={"deployment_id": deployment_id, "deployment": result, "runtime": _registry_runtime_summary()},
    )
    return result


@router.post("/deployments/{deployment_id}/deactivate")
async def deactivate_deployment(
    deployment_id: int,
    _user: UserInfo = Depends(require_platform_admin),
):
    result = await set_deployment_active(deployment_id, False)
    if result is None:
        raise HTTPException(404, "deployment not found")
    await record_admin_audit(
        user=_user,
        action="models.deployment_deactivate",
        status="success",
        summary=f"Deactivated deployment {deployment_id}; direct routes update from admin registry",
        detail={"deployment_id": deployment_id, "deployment": result, "runtime": _registry_runtime_summary()},
    )
    return result


@router.post("/refresh-routes")
async def refresh_routes(_user: UserInfo = Depends(require_platform_admin)):
    summary = _registry_runtime_summary()
    await record_admin_audit(
        user=_user,
        action="models.routes_refresh",
        status="success",
        summary="Manual model route refresh requested; admin DB is the runtime source of truth",
        detail={"runtime": summary},
    )
    return summary


@router.put("/deployments/{deployment_id}/fallbacks")
async def set_fallbacks(
    deployment_id: int,
    data: dict = Body(...),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Set fallback model names for a deployment. Body: {"fallbacks": ["model-a", "model-b"]}."""
    fallbacks = data.get("fallbacks", [])
    result = await update_deployment(deployment_id, {"fallbacks": fallbacks if fallbacks else None})
    if result is None:
        raise HTTPException(404, "deployment not found")
    await record_admin_audit(
        user=_user,
        action="models.fallbacks_update",
        status="success",
        summary=f"Updated fallbacks for deployment {deployment_id}; direct routes update from admin registry",
        detail={
            "deployment_id": deployment_id,
            "fallbacks": fallbacks,
            "runtime": _registry_runtime_summary(),
        },
    )
    return result


# ---------------------------------------------------------------------------
# Costs
# ---------------------------------------------------------------------------


async def _build_active_cost_rows() -> list[dict]:
    """Resolve active-role pricing rows for both user and internal callers."""
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
            result.append(
                {
                    "role": role,
                    "model": model,
                    "served_name": served_name or f"synesis-{role}",
                    "profile": "",
                    "source": manual.get("source", provider),
                    "provider": provider,
                    "input_per_million": manual["input_per_million"],
                    "input_cached_per_million": manual.get("input_cached_per_million"),
                    "input_cache_write_per_million": manual.get("input_cache_write_per_million"),
                    "output_per_million": manual["output_per_million"],
                    "monthly_fixed_cost": manual.get("monthly_fixed_cost", 0.0),
                    "cost_formula": manual.get("cost_formula", ""),
                    "notes": manual.get("notes", ""),
                    "pricing_source": "manual",
                }
            )
            continue

        # For local providers, check infra cost calculator.
        if provider in ("vllm", "kserve"):
            infra = await get_infra_config_for_role(role)
            if infra and infra.get("input_per_million", 0) > 0:
                result.append(
                    {
                        "role": role,
                        "model": model,
                        "served_name": served_name or f"synesis-{role}",
                        "profile": "",
                        "source": provider,
                        "provider": provider,
                        "input_per_million": infra["input_per_million"],
                        "input_cached_per_million": None,
                        "input_cache_write_per_million": None,
                        "output_per_million": infra["output_per_million"],
                        "monthly_fixed_cost": infra.get("hourly_rate", 0) * 730,
                        "cost_formula": f"{infra.get('cloud', '')} {infra.get('instance_type', '')} @ ${infra.get('hourly_rate', 0):.2f}/hr",
                        "notes": infra.get("notes", ""),
                        "pricing_source": "infra_calc",
                    }
                )
                continue

        # For API providers, try auto-lookup.
        pricing = await resolve_pricing(provider, model, served_name)
        if pricing:
            rates, source = pricing
            cached_rate = rates[2] if len(rates) > 2 else None
            result.append(
                {
                    "role": role,
                    "model": model,
                    "served_name": served_name or f"synesis-{role}",
                    "profile": "",
                    "source": provider,
                    "provider": provider,
                    "input_per_million": rates[0],
                    "input_cached_per_million": cached_rate,
                    "input_cache_write_per_million": rates[3] if len(rates) > 3 else None,
                    "output_per_million": rates[1],
                    "monthly_fixed_cost": 0.0,
                    "cost_formula": "",
                    "notes": f"auto: {source}",
                    "pricing_source": source,
                }
            )
            continue

        # Fallback: conservative base rates so costs never silently stay $0.
        result.append(
            {
                "role": role,
                "model": model,
                "served_name": served_name or f"synesis-{role}",
                "profile": "",
                "source": provider,
                "provider": provider,
                "input_per_million": 1.0,
                "input_cached_per_million": 0.1,
                "input_cache_write_per_million": None,
                "output_per_million": 5.0,
                "monthly_fixed_cost": 0.0,
                "cost_formula": "",
                "notes": "fallback base rates — set real pricing in Model Registry",
                "pricing_source": "fallback_base",
            }
        )

    return result


def _pricing_by_role_from_active_rows(
    active_rows: list[dict],
) -> dict[str, tuple[float, float, float | None, float | None]]:
    return {
        str(r.get("role", "")): (
            float(r.get("input_per_million", 0.0) or 0.0),
            float(r.get("output_per_million", 0.0) or 0.0),
            (float(r.get("input_cached_per_million")) if r.get("input_cached_per_million") is not None else None),
            (
                float(r.get("input_cache_write_per_million"))
                if r.get("input_cache_write_per_million") is not None
                else None
            ),
        )
        for r in active_rows
    }


@router.get("/costs/active")
async def active_costs(_user: UserInfo = Depends(require_org_admin)):
    """Rate configuration for active role assignments only."""
    return {"roles": await _build_active_cost_rows()}


@router.get("/costs/active/internal")
async def active_costs_internal(
    _principal: ServicePrincipal | UserInfo = Depends(require_service_or_platform_admin),
):
    """Internal service read path for active-role costs (Yarn tier polling)."""
    return {"costs": await _build_active_cost_rows()}


@router.get("/costs")
async def model_costs(_user: UserInfo = Depends(require_org_admin)):
    costs = await get_cost_estimates()
    return {"roles": costs}


@router.put("/costs")
async def update_model_cost(
    data: dict = Body(...),
    _user: UserInfo = Depends(require_platform_admin),
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


@router.put("/costs/internal")
async def update_model_cost_internal(
    data: dict = Body(...),
    _principal: ServicePrincipal | UserInfo = Depends(require_service_or_platform_admin),
):
    """Internal service write path for cost rates (bootstrap / automation)."""
    result = await upsert_model_cost(data)
    actor_name = getattr(_principal, "service_name", None) or getattr(_principal, "username", "service")
    await record_admin_audit(
        user=_principal
        if isinstance(_principal, UserInfo)
        else UserInfo(
            user_id="service",
            username=actor_name,
            email="",
            role="platform_admin",
            org_id="synesis",
            groups=[],
        ),
        action="models.cost_update_internal",
        status="success",
        summary=f"Internal cost update for role={result.get('role', data.get('role'))}",
        detail={"cost": result},
    )
    return result


@router.get("/costs/by-model")
async def costs_by_model(
    _user: UserInfo = Depends(require_org_admin),
    days: int = Query(7, ge=1, le=90),
):
    """Per-model usage price breakdown; provider actual is platform-admin only."""
    cutoff = time.time() - days * 86400
    include_provider_actual = resolve_role(_user) >= Role.platform_admin
    scope = trace_scope_filters(_user)
    scope_user_id = scope.get("user_id", "")
    scope_org_id = scope.get("org_id", "")
    try:
        async with async_session() as session:
            q = select(Trace.full_record, Trace.estimated_cost_usd, Trace.actual_cost_usd).where(
                Trace.timestamp >= cutoff
            )
            if scope_user_id:
                q = q.where(Trace.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(Trace.full_record["org_id"].astext == scope_org_id)
            result = await session.execute(q)
            rows = result.all()

        pricing_by_role = _pricing_by_role_from_active_rows(await _build_active_cost_rows())

        model_agg: dict[str, dict] = {}
        for row in rows:
            full = row[0] or {}
            for span in full.get("spans", []):
                node = span.get("node_name", "unknown")
                for call in span.get("llm_calls", []):
                    model = call.get("model", "unknown")
                    if model not in model_agg:
                        model_agg[model] = {
                            "model": model,
                            "prompt_tokens": 0,
                            "completion_tokens": 0,
                            "cached_prompt_tokens": 0,
                            "requests": 0,
                            "price_usd": 0.0,
                            **({"provider_actual_cost_usd": 0.0} if include_provider_actual else {}),
                        }
                    agg = model_agg[model]
                    agg["prompt_tokens"] += call.get("prompt_tokens", 0)
                    agg["completion_tokens"] += call.get("completion_tokens", 0)
                    agg["cached_prompt_tokens"] += call.get("cached_prompt_tokens", 0)
                    agg["requests"] += 1
                    role = _resolve_llm_call_role(
                        call_role=call.get("role", ""),
                        node_name=node,
                        model_name=call.get("model", ""),
                    )
                    inp_r, out_r, ic_r, icw_r = pricing_by_role.get(role, (0.0, 0.0, None, None))
                    est = parse_recorded_estimated_cost(call)
                    agg["price_usd"] += (
                        est
                        if est is not None
                        else estimate_llm_call_cost_from_payload(
                            call,
                            input_per_million=inp_r,
                            output_per_million=out_r,
                            input_cached_per_million=ic_r,
                            input_cache_write_per_million=icw_r,
                        )
                    )
                    if include_provider_actual:
                        agg["provider_actual_cost_usd"] += float(call.get("actual_cost", 0.0) or 0.0)

        for model, agg in model_agg.items():
            agg["price_usd"] = round(agg["price_usd"], 6)
            if include_provider_actual:
                agg["provider_actual_cost_usd"] = round(agg["provider_actual_cost_usd"], 6)

        return {
            "models": sorted(model_agg.values(), key=lambda x: x["price_usd"], reverse=True),
            "period_days": days,
        }
    except Exception:
        logger.warning("costs_by_model_failed", exc_info=True)
        return {"models": await get_cost_by_model(), "period_days": days}


@router.get("/costs/by-role")
async def costs_by_role(
    _user: UserInfo = Depends(require_org_admin),
    days: int = Query(7, ge=1, le=90),
):
    """Per-role usage price breakdown; provider actual is platform-admin only."""
    cutoff = time.time() - days * 86400
    include_provider_actual = resolve_role(_user) >= Role.platform_admin
    scope = trace_scope_filters(_user)
    scope_user_id = scope.get("user_id", "")
    scope_org_id = scope.get("org_id", "")
    try:
        async with async_session() as session:
            q = select(Trace.full_record).where(Trace.timestamp >= cutoff)
            if scope_user_id:
                q = q.where(Trace.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(Trace.full_record["org_id"].astext == scope_org_id)
            result = await session.execute(q)
            rows = result.all()

        pricing = _pricing_by_role_from_active_rows(await _build_active_cost_rows())

        role_agg: dict[str, dict] = {}
        for row in rows:
            full = row[0] or {}
            for span in full.get("spans", []):
                node = span.get("node_name", "unknown")
                for call in span.get("llm_calls", []):
                    role = _resolve_llm_call_role(
                        call_role=call.get("role", ""),
                        node_name=node,
                        model_name=call.get("model", ""),
                    )
                    if role not in role_agg:
                        role_agg[role] = {
                            "role": role,
                            "prompt_tokens": 0,
                            "completion_tokens": 0,
                            "cached_prompt_tokens": 0,
                            "requests": 0,
                            "price_usd": 0.0,
                            **({"provider_actual_cost_usd": 0.0} if include_provider_actual else {}),
                        }
                    agg = role_agg[role]
                    agg["prompt_tokens"] += call.get("prompt_tokens", 0)
                    agg["completion_tokens"] += call.get("completion_tokens", 0)
                    agg["cached_prompt_tokens"] += call.get("cached_prompt_tokens", 0)
                    agg["requests"] += 1
                    inp_r, out_r, ic_r, icw_r = pricing.get(role, (0.0, 0.0, None, None))
                    est = parse_recorded_estimated_cost(call)
                    agg["price_usd"] += (
                        est
                        if est is not None
                        else estimate_llm_call_cost_from_payload(
                            call,
                            input_per_million=inp_r,
                            output_per_million=out_r,
                            input_cached_per_million=ic_r,
                            input_cache_write_per_million=icw_r,
                        )
                    )
                    if include_provider_actual:
                        agg["provider_actual_cost_usd"] += float(call.get("actual_cost", 0.0) or 0.0)

        for role, agg in role_agg.items():
            agg["price_usd"] = round(agg["price_usd"], 6)
            if include_provider_actual:
                agg["provider_actual_cost_usd"] = round(agg["provider_actual_cost_usd"], 6)

        return {"roles": sorted(role_agg.values(), key=lambda x: x["price_usd"], reverse=True), "period_days": days}
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
    if "writer" in node_lower or "writer" in model_lower:
        return "writer"
    if "planner" in node_lower or "planner" in model_lower:
        return "planner"
    return node_name or "unknown"


def _resolve_llm_call_role(call_role: str, node_name: str, model_name: str) -> str:
    explicit = str(call_role or "").strip().lower()
    if explicit:
        return explicit
    return _infer_role(node_name, model_name)


@router.get("/costs/daily")
async def costs_daily(
    _user: UserInfo = Depends(require_org_admin),
    days: int = Query(7, ge=1, le=90),
):
    """Per-day usage price rollup; provider actual is platform-admin only."""
    cutoff = time.time() - days * 86400
    include_provider_actual = resolve_role(_user) >= Role.platform_admin
    scope = trace_scope_filters(_user)
    scope_user_id = scope.get("user_id", "")
    scope_org_id = scope.get("org_id", "")
    try:
        async with async_session() as session:
            q = (
                select(
                    func.date(func.to_timestamp(Trace.timestamp)).label("day"),
                    func.sum(Trace.total_tokens).label("tokens"),
                    func.count().label("requests"),
                    func.sum(Trace.estimated_cost_usd).label("estimated_cost"),
                    func.sum(Trace.actual_cost_usd).label("actual_cost"),
                )
                .where(Trace.timestamp >= cutoff)
                .group_by(func.date(func.to_timestamp(Trace.timestamp)))
                .order_by(func.date(func.to_timestamp(Trace.timestamp)))
            )
            if scope_user_id:
                q = q.where(Trace.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(Trace.full_record["org_id"].astext == scope_org_id)
            result = await session.execute(q)
            rows = result.all()
            daily = []
            for r in rows:
                item = {
                    "date": str(r.day),
                    "tokens": int(r.tokens or 0),
                    "requests": r.requests,
                    "price_usd": round(float(r.estimated_cost or 0), 6),
                }
                if include_provider_actual:
                    item["provider_actual_cost_usd"] = round(float(r.actual_cost or 0), 6)
                daily.append(item)
            return {"daily": daily, "period_days": days}
    except Exception:
        logger.warning("costs_daily_failed", exc_info=True)
        return {"daily": [], "period_days": days}


# ---------------------------------------------------------------------------
# Performance (legacy Prometheus)
# ---------------------------------------------------------------------------


@router.get("/performance")
async def model_performance(_user: UserInfo = Depends(require_org_admin)):
    models = await prom.get_model_performance()
    return {"models": models, "period": "24h"}


# ---------------------------------------------------------------------------
# Performance (trace-based detailed)
# ---------------------------------------------------------------------------


@router.get("/performance/detailed")
async def performance_detailed(
    _user: UserInfo = Depends(require_org_admin),
    days: int = Query(7, ge=1, le=90),
):
    """Per-model performance metrics aggregated from trace LLM calls."""
    cutoff = time.time() - days * 86400
    include_provider_actual = resolve_role(_user) >= Role.platform_admin
    scope = trace_scope_filters(_user)
    scope_user_id = scope.get("user_id", "")
    scope_org_id = scope.get("org_id", "")
    try:
        async with async_session() as session:
            q = select(Trace.full_record).where(Trace.timestamp >= cutoff)
            if scope_user_id:
                q = q.where(Trace.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(Trace.full_record["org_id"].astext == scope_org_id)
            result = await session.execute(q)
            rows = result.all()

        pricing_by_role = _pricing_by_role_from_active_rows(await _build_active_cost_rows())
        model_stats: dict[str, dict] = {}
        for row in rows:
            full = row[0] or {}
            for span in full.get("spans", []):
                node = span.get("node_name", "unknown")
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
                            "total_price_usd": 0.0,
                            **({"total_provider_actual_cost_usd": 0.0} if include_provider_actual else {}),
                        }
                    ms = model_stats[model]
                    lat = call.get("latency_ms", 0)
                    ms["request_count"] += 1
                    ms["latencies"].append(lat)
                    ms["total_tokens"] += call.get("total_tokens", 0)
                    ms["total_prompt_tokens"] += call.get("prompt_tokens", 0)
                    ms["total_completion_tokens"] += call.get("completion_tokens", 0)
                    ms["total_cached_prompt_tokens"] += call.get("cached_prompt_tokens", 0)
                    role = _resolve_llm_call_role(
                        call_role=call.get("role", ""),
                        node_name=node,
                        model_name=call.get("model", ""),
                    )
                    inp_r, out_r, ic_r, icw_r = pricing_by_role.get(role, (0.0, 0.0, None, None))
                    recorded = parse_recorded_estimated_cost(call)
                    ms["total_price_usd"] += (
                        recorded
                        if recorded is not None
                        else estimate_llm_call_cost_from_payload(
                            call,
                            input_per_million=inp_r,
                            output_per_million=out_r,
                            input_cached_per_million=ic_r,
                            input_cache_write_per_million=icw_r,
                        )
                    )
                    if include_provider_actual:
                        ms["total_provider_actual_cost_usd"] += float(call.get("actual_cost", 0.0) or 0.0)

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
            ms["total_price_usd"] = round(ms["total_price_usd"], 6)
            if include_provider_actual:
                ms["total_provider_actual_cost_usd"] = round(ms["total_provider_actual_cost_usd"], 6)
            results.append(ms)

        results.sort(key=lambda x: x["request_count"], reverse=True)
        return {"models": results, "period_days": days}

    except Exception:
        logger.warning("performance_detailed_failed", exc_info=True)
        return {"models": [], "period_days": days}


@router.get("/performance/latency-trend")
async def latency_trend(
    _user: UserInfo = Depends(require_org_admin),
    days: int = Query(14, ge=1, le=90),
):
    """Per-model daily latency trend from trace LLM calls."""
    cutoff = time.time() - days * 86400
    scope = trace_scope_filters(_user)
    scope_user_id = scope.get("user_id", "")
    scope_org_id = scope.get("org_id", "")
    try:
        async with async_session() as session:
            q = select(Trace.timestamp, Trace.full_record).where(Trace.timestamp >= cutoff)
            if scope_user_id:
                q = q.where(Trace.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(Trace.full_record["org_id"].astext == scope_org_id)
            result = await session.execute(q)
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
    _user: UserInfo = Depends(require_org_admin),
    days: int = Query(7, ge=1, le=90),
):
    """Per-role performance metrics aggregated from trace LLM calls."""
    cutoff = time.time() - days * 86400
    include_provider_actual = resolve_role(_user) >= Role.platform_admin
    scope = trace_scope_filters(_user)
    scope_user_id = scope.get("user_id", "")
    scope_org_id = scope.get("org_id", "")
    try:
        async with async_session() as session:
            q = select(Trace.full_record).where(Trace.timestamp >= cutoff)
            if scope_user_id:
                q = q.where(Trace.user_id == scope_user_id)
            elif scope_org_id:
                q = q.where(Trace.full_record["org_id"].astext == scope_org_id)
            result = await session.execute(q)
            rows = result.all()

        pricing_by_role = _pricing_by_role_from_active_rows(await _build_active_cost_rows())
        role_stats: dict[str, dict] = {}
        for row in rows:
            full = row[0] or {}
            for span in full.get("spans", []):
                node = span.get("node_name", "unknown")
                for call in span.get("llm_calls", []):
                    role = _resolve_llm_call_role(
                        call_role=call.get("role", ""),
                        node_name=node,
                        model_name=call.get("model", ""),
                    )
                    if role not in role_stats:
                        role_stats[role] = {
                            "role": role,
                            "request_count": 0,
                            "latencies": [],
                            "total_tokens": 0,
                            "total_prompt_tokens": 0,
                            "total_cached_prompt_tokens": 0,
                            "total_price_usd": 0.0,
                            **({"total_provider_actual_cost_usd": 0.0} if include_provider_actual else {}),
                        }
                    rs = role_stats[role]
                    rs["request_count"] += 1
                    rs["latencies"].append(call.get("latency_ms", 0))
                    rs["total_tokens"] += call.get("total_tokens", 0)
                    rs["total_prompt_tokens"] += call.get("prompt_tokens", 0)
                    rs["total_cached_prompt_tokens"] += call.get("cached_prompt_tokens", 0)
                    inp_r, out_r, ic_r, icw_r = pricing_by_role.get(role, (0.0, 0.0, None, None))
                    recorded = parse_recorded_estimated_cost(call)
                    rs["total_price_usd"] += (
                        recorded
                        if recorded is not None
                        else estimate_llm_call_cost_from_payload(
                            call,
                            input_per_million=inp_r,
                            output_per_million=out_r,
                            input_cached_per_million=ic_r,
                            input_cache_write_per_million=icw_r,
                        )
                    )
                    if include_provider_actual:
                        rs["total_provider_actual_cost_usd"] += float(call.get("actual_cost", 0.0) or 0.0)

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
                    "total_price_usd": 0.0,
                    **({"total_provider_actual_cost_usd": 0.0} if include_provider_actual else {}),
                }
            lats = sorted(rs.pop("latencies"))
            n = len(lats)
            avg_lat = sum(lats) / n if n else 0
            p95_idx = int(n * 0.95) if n else 0
            tp = rs.get("total_prompt_tokens", 0)
            tc = rs.get("total_cached_prompt_tokens", 0)
            cache_hit = round(tc / tp, 4) if tp > 0 else 0.0
            a = reg_by_role.get(role, {})
            results.append(
                {
                    **rs,
                    "cache_hit_rate": cache_hit,
                    "avg_latency_ms": round(avg_lat, 1),
                    "p95_latency_ms": round(lats[min(p95_idx, n - 1)] if n else 0, 1),
                    "total_price_usd": round(rs["total_price_usd"], 6),
                    "registry_model": a.get("model", ""),
                    "registry_provider": a.get("provider", ""),
                    "served_name": a.get("served_name", f"synesis-{role}"),
                    "assigned": bool(a.get("assigned")),
                }
            )
            if include_provider_actual:
                results[-1]["total_provider_actual_cost_usd"] = round(rs["total_provider_actual_cost_usd"], 6)

        return {"roles": results, "period_days": days}

    except Exception:
        logger.warning("performance_by_role_failed", exc_info=True)
        return {"roles": [], "period_days": days}


# ---------------------------------------------------------------------------
# Model Policies — conditional model selection rules per role
# ---------------------------------------------------------------------------

CONDITION_TYPES = ("difficulty_lt", "difficulty_gte", "account_tier", "user_preference", "always")


class EffortRecommendationPreviewRequest(BaseModel):
    prompt: str
    effort_mode: str | None = None
    include_frame: bool = False
    operational_health: float | None = None


def _internal_service_token() -> str:
    token = os.getenv("SYNESIS_INTERNAL_SERVICE_TOKEN", "").strip()
    if token:
        return token
    many = os.getenv("SYNESIS_INTERNAL_SERVICE_TOKENS", "").strip()
    if not many:
        return ""
    return next((t.strip() for t in many.split(",") if t.strip()), "")


@router.post("/effort/recommend")
async def preview_effort_recommendation(
    req: EffortRecommendationPreviewRequest,
    _user: UserInfo = Depends(require_org_admin),
):
    """Proxy planner /v1/effort/recommend for admin tuning UI."""
    prompt = (req.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    service_token = _internal_service_token()
    if not service_token:
        raise HTTPException(status_code=503, detail="Internal service token is not configured")

    planner_url = f"{PLANNER_URL.rstrip('/')}/v1/effort/recommend"
    payload = {
        "prompt": prompt,
        "effort_mode": req.effort_mode,
        "include_frame": req.include_frame,
        "operational_health": req.operational_health,
    }
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                planner_url,
                json=payload,
                headers={"Authorization": f"Bearer {service_token}"},
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="Planner request timed out") from exc
    except Exception as exc:
        logger.warning("planner_effort_proxy_failed", exc_info=True)
        raise HTTPException(status_code=502, detail="Planner request failed") from exc

    if resp.status_code != 200:
        detail = resp.text[:300] if getattr(resp, "text", "") else f"planner returned {resp.status_code}"
        raise HTTPException(status_code=502, detail=detail)
    return resp.json()


@router.get("/policies")
async def list_model_policies(_user: UserInfo = Depends(require_org_admin)):
    """All active model policies grouped by role."""
    try:
        async with async_session() as session:
            rows = (
                await session.execute(
                    text(
                        "SELECT id, role, priority, condition_type, condition_value, "
                        "model, label, enabled "
                        "FROM model_policies ORDER BY role, priority"
                    )
                )
            ).fetchall()
    except Exception:
        return {"policies": {}}

    policies: dict[str, list[dict]] = {}
    for row in rows:
        role = row[1]
        policies.setdefault(role, []).append(
            {
                "id": row[0],
                "role": role,
                "priority": row[2],
                "condition_type": row[3],
                "condition_value": row[4],
                "model": row[5],
                "label": row[6],
                "enabled": row[7],
            }
        )
    return {"policies": policies}


@router.get("/policies/{role}")
async def get_role_policies(role: str, _user: UserInfo = Depends(require_org_admin)):
    """Ordered rules for one role."""
    if role not in KNOWN_ROLES:
        raise HTTPException(404, f"Unknown role: {role}")
    try:
        async with async_session() as session:
            rows = (
                await session.execute(
                    text(
                        "SELECT id, priority, condition_type, condition_value, "
                        "model, label, enabled "
                        "FROM model_policies WHERE role = :role ORDER BY priority"
                    ),
                    {"role": role},
                )
            ).fetchall()
    except Exception:
        return {"role": role, "rules": [], "preview": {}}

    rules = [
        {
            "id": r[0],
            "priority": r[1],
            "condition_type": r[2],
            "condition_value": r[3],
            "model": r[4],
            "label": r[5],
            "enabled": r[6],
        }
        for r in rows
    ]
    preview = _preview_policy(rules)
    return {"role": role, "rules": rules, "preview": preview}


@router.put("/policies/{role}")
async def put_role_policies(
    role: str,
    rules: list[dict] = Body(...),
    user: UserInfo = Depends(require_platform_admin),
):
    """Replace all rules for a role atomically."""
    if role not in KNOWN_ROLES:
        raise HTTPException(404, f"Unknown role: {role}")
    for r in rules:
        ct = r.get("condition_type", "")
        if ct not in CONDITION_TYPES:
            raise HTTPException(422, f"Invalid condition_type: {ct}")
        if not r.get("model"):
            raise HTTPException(422, "Each rule must have a model")

    async with async_session() as session:
        async with session.begin():
            await session.execute(
                text("DELETE FROM model_policies WHERE role = :role"),
                {"role": role},
            )
            for idx, r in enumerate(rules):
                policy = ModelPolicy(
                    role=role,
                    priority=idx,
                    condition_type=r["condition_type"],
                    condition_value=str(r.get("condition_value", "")),
                    model=r["model"],
                    label=r.get("label", ""),
                    enabled=r.get("enabled", True),
                )
                session.add(policy)

    await record_admin_audit(
        user=user,
        action="model_policy_updated",
        status="success",
        summary=f"Updated model policies for role {role}",
        detail={"resource_type": "model_policy", "resource_id": role, "rules_count": len(rules)},
    )
    return {"role": role, "rules_count": len(rules), "preview": _preview_policy(rules)}


@router.delete("/policies/{role}")
async def delete_role_policies(
    role: str,
    user: UserInfo = Depends(require_platform_admin),
):
    """Remove all rules for a role (reverts to static default)."""
    if role not in KNOWN_ROLES:
        raise HTTPException(404, f"Unknown role: {role}")
    async with async_session() as session:
        async with session.begin():
            await session.execute(
                text("DELETE FROM model_policies WHERE role = :role"),
                {"role": role},
            )
    await record_admin_audit(
        user=user,
        action="model_policy_deleted",
        status="success",
        summary=f"Deleted model policies for role {role}",
        detail={"resource_type": "model_policy", "resource_id": role},
    )
    return {"role": role, "deleted": True}


def _preview_policy(rules: list[dict]) -> dict[str, str]:
    """Preview model selection at various difficulty levels."""
    points = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    enabled = [r for r in rules if r.get("enabled", True)]
    result: dict[str, str] = {}
    for d in points:
        matched = "(default)"
        for r in enabled:
            ct = r.get("condition_type", "")
            cv = r.get("condition_value", "")
            if ct == "difficulty_lt":
                try:
                    if d < float(cv):
                        matched = r.get("model", "")
                        break
                except (ValueError, TypeError):
                    continue
            elif ct == "difficulty_gte":
                try:
                    if d >= float(cv):
                        matched = r.get("model", "")
                        break
                except (ValueError, TypeError):
                    continue
            elif ct == "always":
                matched = r.get("model", "")
                break
        result[str(d)] = matched
    return result
