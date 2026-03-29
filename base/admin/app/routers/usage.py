"""Usage endpoints — trace-backed token/cost accounting with RBAC scoping."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import UserInfo, get_current_user
from ..rbac import RouteGroup, can_access_route_group, trace_scope_filters
from ..services.trace_store import aggregate_traces_period, trace_time_series
from ..services.usage_unified import get_summary_unified

router = APIRouter(prefix="/api/v1/usage", tags=["usage"])


def _ensure_org_observability(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_observability):
        raise HTTPException(status_code=403, detail="Requires route group access: org_observability")


@router.get("")
async def usage_series(
    since_hours: int = Query(24, ge=1, le=720),
    _user: UserInfo = Depends(get_current_user),
):
    """Time-series usage data (hourly buckets from traces), scoped to the caller's role."""
    _ensure_org_observability(_user)
    scope = trace_scope_filters(_user)
    return await trace_time_series(
        since_hours=since_hours,
        scope_user_id=scope.get("user_id", ""),
        scope_org_id=scope.get("org_id", ""),
        scope_tenant_id=scope.get("scope_tenant_id", ""),
    )


@router.get("/summary")
async def usage_summary(
    since_hours: int = Query(24, ge=1, le=720),
    _user: UserInfo = Depends(get_current_user),
):
    """Aggregated usage totals over a period, scoped to the caller's role."""
    _ensure_org_observability(_user)
    scope = trace_scope_filters(_user)
    return await aggregate_traces_period(
        since_hours=since_hours,
        scope_user_id=scope.get("user_id", ""),
        scope_org_id=scope.get("org_id", ""),
        scope_tenant_id=scope.get("scope_tenant_id", ""),
    )


@router.get("/summary-unified")
async def usage_summary_unified(
    since_hours: int = Query(24, ge=1, le=720),
    user: UserInfo = Depends(get_current_user),
):
    """Pipeline traces + optional Yarn totals (org_admin+); glossary for UI."""
    _ensure_org_observability(user)
    return await get_summary_unified(user=user, since_hours=since_hours)
