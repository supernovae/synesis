"""Security safety console API — guardrail event listing, triage, and containment actions."""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from ..auth import UserInfo, get_current_user
from ..internal_auth import require_internal_service_token_request
from ..rbac import Role, RouteGroup, can_access_route_group, require_caller_org_id, resolve_role
from ..services import security_service
from ..services.admin_audit import record_admin_audit

logger = logging.getLogger("synesis.admin.security")

router = APIRouter(prefix="/api/v1/security", tags=["security"])

SecuritySeverity = Literal["low", "medium", "high"]
SecurityEventType = Literal[
    "system_override_attempt",
    "jailbreak_roleplay",
    "context_confusion_attack",
    "code_exec_risk",
    "prompt_leakage_attempt",
    "unknown",
    "yarn_policy_reject",
]
SecurityService = Literal["planner", "yarn"]
SecurityConfidenceBand = Literal["low", "medium", "high"]
SecurityActionTaken = Literal["allow", "log", "reduce", "block"]
SecurityResolveAction = Literal["acknowledge", "suppress", "false_positive", "freeze_token", "restrict_tools"]


def _ensure_org_observability(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_observability):
        raise HTTPException(status_code=403, detail="Requires route group access: org_observability")


def _scope_org(user: UserInfo) -> str:
    role = resolve_role(user)
    if role >= Role.platform_admin:
        return ""
    return require_caller_org_id(user, surface="org-scoped security access")


# ── List / summary ────────────────────────────────────────────────────────────


@router.get("/events")
async def list_events(
    user: UserInfo = Depends(get_current_user),
    limit: int = Query(100, ge=1, le=500),
    before_id: int | None = Query(None, ge=1),
    severity: SecuritySeverity | None = Query(None),
    event_type: SecurityEventType | None = Query(None),
    service: SecurityService | None = Query(None),
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
    model_config = ConfigDict(extra="forbid")

    action: SecurityResolveAction
    reason: str = Field(..., min_length=1, max_length=8000)


class SecurityEventDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tier: Literal["core", "web", "output"] | None = None
    source: str | None = Field(None, max_length=128)
    patterns_count: int | None = Field(None, ge=0, le=1000)
    reason: str | None = Field(None, max_length=2000)


class SecurityIngestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: str = Field(..., min_length=1, max_length=64)
    event_type: SecurityEventType
    severity: SecuritySeverity
    confidence: float = Field(..., ge=0.0, le=1.0)
    confidence_band: SecurityConfidenceBand
    action_taken: SecurityActionTaken
    scope: Literal["request"]
    service: SecurityService
    request_id: str = Field("", max_length=128)
    session_id: str = Field("", max_length=256)
    user_id: str = Field("", max_length=256)
    token_id: str = Field("", max_length=64)
    org_id: str = Field("", max_length=256)
    patterns_found: list[str] = Field(default_factory=list, max_length=50)
    excerpt: str = Field("", max_length=4000)
    scanner_name: Literal["synesis_guardrails_ts", "deterministic_policy_engine"]
    latency_ms: float = Field(0.0, ge=0.0, le=60000.0)
    detail: SecurityEventDetail = Field(default_factory=SecurityEventDetail)


@router.post("/events/{event_id}/resolve")
async def resolve_event(
    body: ResolveRequest,
    event_id: str = Path(..., min_length=1, max_length=64),
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
async def ingest_event(request: Request, body: SecurityIngestRequest):
    """Accept security event payloads from Planner or Yarn.

    Service-to-service only; callers must present the configured internal token.
    """
    require_internal_service_token_request(request)
    event_id = await security_service.ingest_event(body.model_dump(mode="json", exclude_none=True))
    return {"event_id": event_id, "status": "ingested"}
