"""Yarn Ops API — RBAC-scoped endpoints for Yarn sessions, events, performance,
diagnostics, and verification checks."""

from __future__ import annotations

import logging
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import UserInfo, get_current_user
from ..rbac import Role, require_org_admin, resolve_role
from ..services import yarn_service
from ..services.health_prober import probe_service

logger = logging.getLogger("synesis.admin.yarn")

router = APIRouter(prefix="/api/v1/yarn", tags=["yarn"])

_YARN_URL = os.getenv(
    "SYNESIS_YARN_URL",
    "http://synesis-yarn.synesis-yarn.svc.cluster.local:8000",
)


def _scope(user: UserInfo) -> tuple[str, str, str]:
    """Return (scope_user_id, scope_org_id, scope_tenant_id) for Yarn data filters."""
    role = resolve_role(user)
    if role >= Role.platform_admin:
        return "", "", ""
    if role >= Role.org_admin:
        return "", user.org_id or "", ""
    tenant_ids = getattr(user, "tenant_ids", None) or []
    scope_tenant = (tenant_ids[0].strip()[:64]) if tenant_ids else ""
    return user.user_id or user.username, "", scope_tenant


# ── Overview ──────────────────────────────────────────────────────────────────


@router.get("/overview")
async def yarn_overview(
    since_hours: int = Query(24, ge=1, le=720),
    user: UserInfo = Depends(require_org_admin),
):
    scope_user_id, scope_org_id, _tenant_id = _scope(user)
    return await yarn_service.get_yarn_overview(
        since_hours=since_hours,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
    )


@router.get("/intelligence")
async def yarn_intelligence(
    since_hours: int = Query(24, ge=1, le=720),
    user: UserInfo = Depends(require_org_admin),
):
    scope_user_id, scope_org_id, _tenant_id = _scope(user)
    return await yarn_service.get_yarn_intelligence(
        since_hours=since_hours,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
    )


# ── Sessions ──────────────────────────────────────────────────────────────────


@router.get("/sessions")
async def yarn_sessions(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    active_since_hours: int | None = Query(None, ge=1, le=720),
    user: UserInfo = Depends(require_org_admin),
):
    scope_user_id, scope_org_id, _tenant_id = _scope(user)
    return await yarn_service.list_yarn_sessions(
        page=page,
        page_size=page_size,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
        active_since_hours=active_since_hours,
    )


@router.get("/sessions/{session_key:path}")
async def yarn_session_detail(
    session_key: str,
    user: UserInfo = Depends(require_org_admin),
):
    scope_user_id, scope_org_id, _tenant_id = _scope(user)
    detail = await yarn_service.get_yarn_session_detail(
        session_key,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
    )
    if not detail:
        raise HTTPException(status_code=404, detail="Session not found")
    return detail


# ── Events & Errors ───────────────────────────────────────────────────────────


@router.get("/events")
async def yarn_events(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    since_hours: int = Query(24, ge=1, le=720),
    errors_only: bool = Query(False),
    user: UserInfo = Depends(require_org_admin),
):
    scope_user_id, scope_org_id, _tenant_id = _scope(user)
    return await yarn_service.list_yarn_events(
        page=page,
        page_size=page_size,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
        since_hours=since_hours,
        errors_only=errors_only,
    )


# ── Performance ───────────────────────────────────────────────────────────────


@router.get("/performance")
async def yarn_performance(
    since_hours: int = Query(24, ge=1, le=720),
    bucket_minutes: int = Query(15, ge=5, le=60),
    user: UserInfo = Depends(require_org_admin),
):
    scope_user_id, scope_org_id, _tenant_id = _scope(user)
    return await yarn_service.get_yarn_performance(
        since_hours=since_hours,
        bucket_minutes=bucket_minutes,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
    )


# ── Diagnostics passthrough ──────────────────────────────────────────────────


@router.get("/diagnostics/{request_id}")
async def yarn_diagnostics(
    request_id: str,
    user: UserInfo = Depends(require_org_admin),
):
    """Proxy diagnostics snapshot from Yarn service's Redis cache."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{_YARN_URL.rstrip('/')}/v1/diagnostics/{request_id}",
                headers={"Authorization": "Bearer admin-internal"},
            )
            if resp.status_code == 404:
                raise HTTPException(status_code=404, detail="Diagnostics snapshot not found or expired")
            resp.raise_for_status()
            return resp.json()
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("yarn_diagnostics_proxy_error: %s", str(exc)[:120])
        raise HTTPException(status_code=502, detail="Could not reach Yarn diagnostics endpoint")


# ── Verification / Health ────────────────────────────────────────────────────


@router.get("/health")
async def yarn_health(
    user: UserInfo = Depends(require_org_admin),
):
    """Direct health probe of the Yarn service."""
    async with httpx.AsyncClient() as client:
        result = await probe_service(
            client,
            {"name": "synesis-yarn", "url": f"{_YARN_URL.rstrip('/')}/health"},
            category="yarn",
        )
    return result


@router.get("/runtime-telemetry")
async def yarn_runtime_telemetry(
    user: UserInfo = Depends(require_org_admin),
):
    """Proxy runtime telemetry from Yarn /health/telemetry."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{_YARN_URL.rstrip('/')}/health/telemetry")
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:
        logger.warning("yarn_runtime_telemetry_proxy_error: %s", str(exc)[:120])
        raise HTTPException(status_code=502, detail="Could not reach Yarn telemetry endpoint")


@router.post("/verify")
async def yarn_verify(
    user: UserInfo = Depends(require_org_admin),
):
    """Quick smoke test: call Yarn /v1/models to verify it responds."""
    checks: list[dict] = []
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(f"{_YARN_URL.rstrip('/')}/health")
            checks.append(
                {
                    "check": "health",
                    "status": "pass" if resp.status_code == 200 else "fail",
                    "status_code": resp.status_code,
                }
            )
        except Exception as exc:
            checks.append({"check": "health", "status": "fail", "error": str(exc)[:120]})

        try:
            resp = await client.get(f"{_YARN_URL.rstrip('/')}/v1/models")
            checks.append(
                {
                    "check": "models_endpoint",
                    "status": "pass" if resp.status_code == 200 else "fail",
                    "status_code": resp.status_code,
                }
            )
        except Exception as exc:
            checks.append({"check": "models_endpoint", "status": "fail", "error": str(exc)[:120]})

    all_pass = all(c["status"] == "pass" for c in checks)
    return {"overall": "pass" if all_pass else "fail", "checks": checks}


# ── User-scoped usage (for account page) ─────────────────────────────────────


@router.get("/user-usage")
async def yarn_user_usage(
    since_hours: int = Query(720, ge=1, le=8760),
    user: UserInfo = Depends(get_current_user),
):
    """Return Yarn usage for the authenticated user."""
    uid = user.user_id or user.username
    return await yarn_service.get_user_yarn_usage(uid, since_hours=since_hours)
