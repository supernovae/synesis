"""Security safety console API — guardrail event listing, triage, and containment actions."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..auth import UserInfo, get_current_user
from ..rbac import Role, RouteGroup, can_access_route_group, resolve_role
from ..services import security_service
from ..services.admin_audit import record_admin_audit

logger = logging.getLogger("synesis.admin.security")

router = APIRouter(prefix="/api/v1/security", tags=["security"])


def _ensure_org_observability(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_observability):
        raise HTTPException(status_code=403, detail="Requires route group access: org_observability")


def _scope_org(user: UserInfo) -> str:
    role = resolve_role(user)
    if role >= Role.platform_admin:
        return ""
    return user.org_id or ""


# ── List / summary ────────────────────────────────────────────────────────────


@router.get("/events")
async def list_events(
    user: UserInfo = Depends(get_current_user),
    limit: int = Query(100, ge=1, le=500),
    before_id: int | None = Query(None),
    severity: str | None = Query(None),
    event_type: str | None = Query(None),
    service: str | None = Query(None),
    resolved: bool | None = Query(None),
    since_hours: int | None = Query(None, ge=1, le=8760),
):
    _ensure_org_observability(user)
    events = await security_service.list_events(
        limit=limit,
        before_id=before_id,
        severity=severity,
        event_type=event_type,
        service=service,
        resolved=resolved,
        since_hours=since_hours,
        scope_org_id=_scope_org(user),
    )
    return {"events": events}


@router.get("/summary")
async def security_summary(
    user: UserInfo = Depends(get_current_user),
    since_hours: int = Query(24, ge=1, le=8760),
):
    _ensure_org_observability(user)
    return await security_service.get_summary(
        since_hours=since_hours,
        scope_org_id=_scope_org(user),
    )


# ── Triage actions ────────────────────────────────────────────────────────────


class ResolveRequest(BaseModel):
    action: str  # acknowledge, suppress, false_positive, freeze_token, restrict_tools
    reason: str


@router.post("/events/{event_id}/resolve")
async def resolve_event(
    event_id: str,
    body: ResolveRequest,
    user: UserInfo = Depends(get_current_user),
):
    _ensure_org_observability(user)
    result = await security_service.resolve_event(
        event_id=event_id,
        action=body.action,
        reason=body.reason,
        actor=user.username or user.user_id or "",
    )
    if result is None:
        raise HTTPException(404, "Security event not found")

    await record_admin_audit(
        action=f"security_resolve:{body.action}",
        status="success",
        summary=f"Resolved security event {event_id}: {body.action}",
        detail={"event_id": event_id, "resolve_action": body.action, "reason": body.reason},
        user=user,
    )
    return result


# ── Ingest (internal webhook from Planner/Yarn) ──────────────────────────────


@router.post("/events/ingest")
async def ingest_event(body: dict[str, Any]):
    """Accept security event payloads from Planner or Yarn.

    In production this endpoint should be behind internal-only networking
    or a service mesh policy. No user auth required — service-to-service only.
    """
    event_id = await security_service.ingest_event(body)
    return {"event_id": event_id, "status": "ingested"}
