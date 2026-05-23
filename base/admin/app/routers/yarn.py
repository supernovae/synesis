"""Yarn Ops API — RBAC-scoped endpoints for Yarn sessions, events, performance,
diagnostics, and verification checks."""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import YarnReducerTelemetrySnapshot
from ..rbac import Role, require_org_admin, require_platform_admin, resolve_role
from ..services import yarn_service
from ..services.account_usage_service import account_usage_identity_candidates
from ..services.archive_store import ArchiveConfigError
from ..services.health_prober import probe_service
from ..services.telemetry_scraper import get_yarn_reducer_scrape_status
from ..services.yarn_reducer_history import (
    cumulative_reducer_snapshots,
    reducer_snapshot_freshness,
    rollup_reducer_snapshots,
)

logger = logging.getLogger("synesis.admin.yarn")

router = APIRouter(prefix="/api/v1/yarn", tags=["yarn"])

_YARN_URL = os.getenv(
    "SYNESIS_YARN_URL",
    "http://synesis-yarn.synesis-yarn.svc.cluster.local:8000",
)


class YarnSessionArchiveRequest(BaseModel):
    session_keys: list[str] = Field(default_factory=list, max_length=500)
    older_than_days: int | None = Field(default=None, ge=1, le=3650)
    session_key_prefix: str = Field(default="", max_length=128)
    dry_run: bool = True
    delete_after_archive: bool = False


class YarnSessionBulkDeleteRequest(BaseModel):
    session_keys: list[str] = Field(..., min_length=1, max_length=500)


class RuntimePreferencesRequest(BaseModel):
    loopBreakMode: str = Field("standard", pattern="^(standard|assertive|hands_off)$")
    cachePolicyBias: str = Field("auto", pattern="^(auto|cache_first|balanced|efficiency_first)$")
    allowAggressiveCompactionWithoutCacheHits: bool = True
    maxToolLoopSoftFails: int | None = Field(None, ge=1, le=20)


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


def _include_provider_actual(user: UserInfo) -> bool:
    return resolve_role(user) >= Role.platform_admin


def _internal_headers() -> dict[str, str]:
    token = os.getenv("SYNESIS_INTERNAL_SERVICE_TOKEN", "").strip()
    if not token:
        raise HTTPException(503, "SYNESIS_INTERNAL_SERVICE_TOKEN is required for Yarn runtime preferences")
    return {"Authorization": f"Bearer {token}"}


def _user_pref_id(user: UserInfo) -> str:
    return quote((user.user_id or user.username or "").strip(), safe="")


@router.get("/runtime-preferences")
async def get_runtime_preferences(user: UserInfo = Depends(get_current_user)):
    """Current user's advanced Coder runtime preferences."""
    user_id = _user_pref_id(user)
    if not user_id:
        raise HTTPException(400, "User identity is unavailable")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{_YARN_URL.rstrip('/')}/v1/user-runtime-preferences/{user_id}",
                headers=_internal_headers(),
            )
    except httpx.RequestError as exc:
        raise HTTPException(502, "Yarn runtime preferences service is unavailable") from exc
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, resp.text[:500] or "Yarn runtime preferences request failed")
    return resp.json()


@router.put("/runtime-preferences")
async def update_runtime_preferences(
    body: RuntimePreferencesRequest,
    user: UserInfo = Depends(get_current_user),
):
    """Update current user's advanced Coder runtime preferences."""
    user_id = _user_pref_id(user)
    if not user_id:
        raise HTTPException(400, "User identity is unavailable")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.put(
                f"{_YARN_URL.rstrip('/')}/v1/user-runtime-preferences/{user_id}",
                headers={**_internal_headers(), "Content-Type": "application/json"},
                json=body.model_dump(),
            )
    except httpx.RequestError as exc:
        raise HTTPException(502, "Yarn runtime preferences service is unavailable") from exc
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, resp.text[:500] or "Yarn runtime preferences update failed")
    return resp.json()


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
        include_provider_actual=_include_provider_actual(user),
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
        include_provider_actual=_include_provider_actual(user),
    )


# ── Sessions ──────────────────────────────────────────────────────────────────


@router.get("/sessions")
async def yarn_sessions(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    active_since_hours: int | None = Query(168, ge=1, le=8760),
    user: UserInfo = Depends(require_org_admin),
):
    scope_user_id, scope_org_id, _tenant_id = _scope(user)
    return await yarn_service.list_yarn_sessions(
        page=page,
        page_size=page_size,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
        active_since_hours=active_since_hours,
        include_provider_actual=_include_provider_actual(user),
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
        include_provider_actual=_include_provider_actual(user),
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
        include_provider_actual=_include_provider_actual(user),
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
        include_provider_actual=_include_provider_actual(user),
    )


@router.get("/transition-quality")
async def yarn_transition_quality(
    since_hours: int = Query(168, ge=1, le=720),
    bucket_minutes: int = Query(60, ge=5, le=60),
    user: UserInfo = Depends(require_org_admin),
):
    scope_user_id, scope_org_id, _tenant_id = _scope(user)
    return await yarn_service.get_yarn_transition_quality_series(
        since_hours=since_hours,
        bucket_minutes=bucket_minutes,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
    )


@router.get("/transition-events")
async def yarn_transition_events(
    since_minutes: int = Query(60, ge=1, le=1440),
    limit: int = Query(100, ge=1, le=500),
    after_id: int = Query(0, ge=0),
    risk_only: bool = Query(True),
    include_metadata: bool = Query(False),
    event_kinds: list[str] = Query(default=[]),
    user: UserInfo = Depends(require_org_admin),
):
    scope_user_id, scope_org_id, _tenant_id = _scope(user)
    selected_kinds = [k.strip() for k in event_kinds if k.strip()]
    return await yarn_service.get_yarn_transition_events(
        since_minutes=since_minutes,
        limit=limit,
        after_id=after_id,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
        risk_only=risk_only,
        include_metadata=include_metadata,
        event_kinds=selected_kinds or None,
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
    try:
        async with httpx.AsyncClient() as client:
            result = await probe_service(
                client,
                {"name": "synesis-yarn", "url": f"{_YARN_URL.rstrip('/')}/health"},
                category="yarn",
            )
        if isinstance(result, dict) and result.get("status") == "ok":
            return {"name": "synesis-yarn", "status": "ok"}
        return {"name": "synesis-yarn", "status": "degraded"}
    except Exception:
        logger.warning("yarn_health_probe_failed", exc_info=True)
        raise HTTPException(status_code=502, detail="Could not probe Yarn health endpoint")


@router.get("/runtime-telemetry")
async def yarn_runtime_telemetry(
    user: UserInfo = Depends(require_org_admin),
):
    """Proxy runtime telemetry from Yarn /health/telemetry."""
    try:
        headers: dict[str, str] = {}
        from ..deps import INTERNAL_SERVICE_TOKEN as _IST

        if _IST:
            headers["Authorization"] = f"Bearer {_IST}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{_YARN_URL.rstrip('/')}/health/telemetry", headers=headers)
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:
        logger.warning("yarn_runtime_telemetry_proxy_error: %s", str(exc)[:120])
        raise HTTPException(status_code=502, detail="Could not reach Yarn telemetry endpoint")


@router.get("/reducer-telemetry-history")
async def yarn_reducer_telemetry_history(
    since_hours: int = Query(168, ge=1, le=720),
    user: UserInfo = Depends(require_org_admin),
):
    """Snapshots of Yarn reducer stats written by the admin telemetry scraper (~5 min).

    Rollup sums positive deltas between consecutive snapshots (handles Yarn restarts).
    """
    _ = user
    cutoff = datetime.now(UTC) - timedelta(hours=since_hours)
    async with async_session() as session:
        stmt = (
            select(YarnReducerTelemetrySnapshot)
            .where(YarnReducerTelemetrySnapshot.captured_at >= cutoff)
            .order_by(YarnReducerTelemetrySnapshot.captured_at.asc())
            .limit(4000)
        )
        result = await session.execute(stmt)
        rows = result.scalars().all()

    serialized = [
        {
            "captured_at": r.captured_at.isoformat() if r.captured_at else None,
            "payload": r.payload,
        }
        for r in rows
    ]
    rollup = rollup_reducer_snapshots(serialized)
    cumulative = cumulative_reducer_snapshots(serialized)
    freshness = reducer_snapshot_freshness(serialized)
    scrape_status = get_yarn_reducer_scrape_status()
    return {
        "since_hours": since_hours,
        "snapshot_count": len(serialized),
        "rollup": rollup,
        "cumulative": cumulative,
        "latest_snapshot_at": freshness.get("latest_snapshot_at"),
        "stale": bool(freshness.get("stale")),
        "scrape_status": scrape_status,
        "recent_snapshots": serialized[-72:],
    }


@router.get("/language-packs")
async def yarn_language_packs(
    user: UserInfo = Depends(require_org_admin),
):
    """Proxy language pack conformance matrix from Yarn /health/telemetry."""
    try:
        headers: dict[str, str] = {}
        from ..deps import INTERNAL_SERVICE_TOKEN as _IST

        if _IST:
            headers["Authorization"] = f"Bearer {_IST}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{_YARN_URL.rstrip('/')}/health/telemetry", headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return {"languagePacks": data.get("languagePacks", [])}
    except Exception as exc:
        logger.warning("yarn_language_packs_proxy_error: %s", str(exc)[:120])
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
        except Exception:
            logger.warning("yarn_verify_health_failed", exc_info=True)
            checks.append({"check": "health", "status": "fail", "error": "request_failed"})

        try:
            resp = await client.get(f"{_YARN_URL.rstrip('/')}/v1/models")
            checks.append(
                {
                    "check": "models_endpoint",
                    "status": "pass" if resp.status_code == 200 else "fail",
                    "status_code": resp.status_code,
                }
            )
        except Exception:
            logger.warning("yarn_verify_models_failed", exc_info=True)
            checks.append({"check": "models_endpoint", "status": "fail", "error": "request_failed"})

    all_pass = all(c["status"] == "pass" for c in checks)
    return {"overall": "pass" if all_pass else "fail", "checks": checks}


# ── Purge ─────────────────────────────────────────────────────────────────────


@router.post("/sessions/archive")
async def yarn_sessions_archive(
    body: YarnSessionArchiveRequest,
    user: UserInfo = Depends(require_platform_admin),
):
    """Archive selected or old sessions to object storage, optionally deleting live rows."""
    if not body.session_keys and body.older_than_days is None:
        raise HTTPException(status_code=400, detail="Provide session_keys or older_than_days")
    try:
        return await yarn_service.archive_yarn_sessions(
            session_keys=body.session_keys,
            older_than_days=body.older_than_days,
            session_key_prefix=body.session_key_prefix,
            dry_run=body.dry_run,
            delete_after_archive=body.delete_after_archive,
            actor_user_id=user.user_id or user.username,
        )
    except ArchiveConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/sessions/bulk-delete")
async def yarn_sessions_bulk_delete(
    body: YarnSessionBulkDeleteRequest,
    _user: UserInfo = Depends(require_platform_admin),
):
    """Delete selected sessions and their usage/events from the live DB."""
    return await yarn_service.delete_yarn_sessions(body.session_keys)


@router.post("/sessions/purge")
async def yarn_sessions_purge(
    older_than_days: int = Query(30, ge=1, le=3650),
    session_key_prefix: str = Query(""),
    dry_run: bool = Query(True),
    archive_before_delete: bool = Query(False),
    user: UserInfo = Depends(require_platform_admin),
):
    """Purge sessions (and usage/events) older than the given threshold."""
    try:
        return await yarn_service.purge_yarn_sessions(
            older_than_days=older_than_days,
            session_key_prefix=session_key_prefix,
            dry_run=dry_run,
            archive_before_delete=archive_before_delete,
            actor_user_id=user.user_id or user.username,
        )
    except ArchiveConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ── Safety events ─────────────────────────────────────────────────────────────


@router.get("/safety-events")
async def yarn_safety_events(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    since_hours: int = Query(24, ge=1, le=720),
    event_kind: str | None = Query(None),
    user: UserInfo = Depends(require_org_admin),
):
    scope_user_id, scope_org_id, _tenant_id = _scope(user)
    return await yarn_service.list_yarn_safety_events(
        page=page,
        page_size=page_size,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
        since_hours=since_hours,
        event_kind=event_kind,
    )


@router.get("/safety-summary")
async def yarn_safety_summary(
    since_hours: int = Query(24, ge=1, le=720),
    user: UserInfo = Depends(require_org_admin),
):
    scope_user_id, scope_org_id, _tenant_id = _scope(user)
    return await yarn_service.get_yarn_safety_summary(
        since_hours=since_hours,
        scope_user_id=scope_user_id,
        scope_org_id=scope_org_id,
    )


@router.get("/diagnostics/recent")
async def yarn_diagnostics_recent(
    user: UserInfo = Depends(require_org_admin),
):
    """Proxy recent request diagnostics from Yarn service."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{_YARN_URL.rstrip('/')}/v1/diagnostics/recent")
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:
        logger.warning("yarn_diagnostics_recent_proxy_error: %s", str(exc)[:120])
        raise HTTPException(status_code=502, detail="Could not reach Yarn diagnostics endpoint")


# ── User-scoped usage (for account page) ─────────────────────────────────────


@router.get("/user-usage")
async def yarn_user_usage(
    request: Request,
    since_hours: int = Query(720, ge=1, le=8760),
    user: UserInfo = Depends(get_current_user),
):
    """Return Yarn usage for the authenticated user."""
    uid = user.user_id or user.username
    return await yarn_service.get_user_yarn_usage(
        uid,
        since_hours=since_hours,
        user_ids=account_usage_identity_candidates(user, [getattr(request.state, "yarn_bearer_user_id", "")]),
    )
