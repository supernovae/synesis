"""Usage rollups — pre-aggregated token/cost accounting with RBAC scoping."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ..auth import UserInfo, get_current_user
from ..rbac import require_platform_admin, trace_scope_filters
from ..services.usage_rollup import get_usage, get_usage_summary, run_rollup

router = APIRouter(prefix="/api/v1/usage", tags=["usage"])


@router.get("")
async def usage_series(
    since_hours: int = Query(24, ge=1, le=720),
    _user: UserInfo = Depends(get_current_user),
):
    """Time-series usage data (5-min buckets), scoped to the caller's role."""
    scope = trace_scope_filters(_user)
    return await get_usage(
        since_hours=since_hours,
        scope_user_id=scope.get("user_id", ""),
        scope_org_id=scope.get("org_id", ""),
    )


@router.get("/summary")
async def usage_summary(
    since_hours: int = Query(24, ge=1, le=720),
    _user: UserInfo = Depends(get_current_user),
):
    """Aggregated usage totals over a period, scoped to the caller's role."""
    scope = trace_scope_filters(_user)
    return await get_usage_summary(
        since_hours=since_hours,
        scope_user_id=scope.get("user_id", ""),
        scope_org_id=scope.get("org_id", ""),
    )


@router.post("/rollup")
async def trigger_rollup(
    lookback_minutes: int = Query(15, ge=5, le=1440),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Manually trigger a usage rollup (admin only)."""
    return await run_rollup(lookback_minutes=lookback_minutes)
