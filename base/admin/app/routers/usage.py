"""Usage endpoints — planner_usage_log primary; trace aggregates fallback."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import UserInfo, get_current_user
from ..rbac import Role, RouteGroup, can_access_route_group, resolve_role, trace_scope_filters
from ..services.planner_usage_service import aggregate_planner_usage_period, planner_usage_time_series
from ..services.trace_store import aggregate_traces_period, trace_time_series
from ..services.usage_audit_service import get_user_usage_audit_request, list_user_usage_audit
from ..services.usage_unified import get_summary_unified

router = APIRouter(prefix="/api/v1/usage", tags=["usage"])


def _ensure_org_observability(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_observability):
        raise HTTPException(status_code=403, detail="Requires route group access: org_observability")


def _normalize_usage_summary(pl: dict, trace_fb: dict | None) -> dict:
    """Match legacy Usage UI shape (trace_count, etc.)."""
    if (pl.get("request_count") or 0) > 0:
        src = pl
        note = None
    elif trace_fb and (trace_fb.get("trace_count") or 0) > 0:
        src = trace_fb
        note = "Showing pipeline-only trace aggregates until planner_usage_log has rows."
    else:
        src = pl
        note = None

    n = int(src.get("request_count") or src.get("trace_count") or 0)
    out = {
        "period_hours": src.get("period_hours", pl.get("period_hours", 24)),
        "trace_count": n,
        "total_tokens": int(src.get("total_tokens", 0)),
        "tokens_in": int(src.get("tokens_in", 0)),
        "tokens_cached": int(src.get("tokens_cached", 0)),
        "tokens_cache_write": int(src.get("tokens_cache_write", 0)),
        "estimated_cost_usd": float(src.get("estimated_cost_usd", 0) or 0),
        "estimated_no_cache_cost_usd": float(src.get("estimated_no_cache_cost_usd", 0) or 0),
        "cache_savings_usd": float(src.get("cache_savings_usd", 0) or 0),
        "actual_cost_usd": float(src.get("actual_cost_usd", 0) or 0),
        "avg_duration_ms": float(src.get("avg_duration_ms", 0) or 0),
        "error_count": int(src.get("error_count", 0)),
        "source": src.get("source", "planner_usage_log"),
    }
    if note:
        out["note"] = note
    return out


async def _build_usage_summary(user: UserInfo, since_hours: int, *, allow_trace_fallback: bool = True) -> dict:
    scope = trace_scope_filters(user)
    su = scope.get("user_id", "") or ""
    so = scope.get("org_id", "") or ""
    st = scope.get("scope_tenant_id", "") or ""
    pl = await aggregate_planner_usage_period(
        since_hours=since_hours,
        scope_user_id=su,
        scope_org_id=so,
        scope_tenant_id=st,
    )
    tr = None
    if allow_trace_fallback:
        tr = await aggregate_traces_period(
            since_hours=since_hours,
            scope_user_id=su,
            scope_org_id=so,
            scope_tenant_id=st,
        )
    return _normalize_usage_summary(pl, tr)


@router.get("")
async def usage_series(
    since_hours: int = Query(24, ge=1, le=720),
    _user: UserInfo = Depends(get_current_user),
):
    """Time-series usage (planner_usage_log hourly buckets; trace fallback)."""
    _ensure_org_observability(_user)
    scope = trace_scope_filters(_user)
    su = scope.get("user_id", "") or ""
    so = scope.get("org_id", "") or ""
    st = scope.get("scope_tenant_id", "") or ""
    pl_series = await planner_usage_time_series(
        since_hours=since_hours,
        scope_user_id=su,
        scope_org_id=so,
        scope_tenant_id=st,
    )
    if pl_series and sum(b.get("requests", 0) for b in pl_series) > 0:
        return pl_series
    return await trace_time_series(
        since_hours=since_hours,
        scope_user_id=su,
        scope_org_id=so,
        scope_tenant_id=st,
    )


@router.get("/summary")
async def usage_summary(
    since_hours: int = Query(24, ge=1, le=720),
    _user: UserInfo = Depends(get_current_user),
):
    """Aggregated usage totals (planner_usage_log; trace fallback)."""
    _ensure_org_observability(_user)
    return await _build_usage_summary(_user, since_hours, allow_trace_fallback=True)


@router.get("/me/summary")
async def usage_me_summary(
    since_hours: int = Query(24, ge=1, le=720),
    user: UserInfo = Depends(get_current_user),
):
    """Same usage totals as /summary for any authenticated user (self scope)."""
    if resolve_role(user) < Role.user:
        raise HTTPException(status_code=403, detail="Authentication required")
    return await _build_usage_summary(user, since_hours, allow_trace_fallback=False)


@router.get("/me/series")
async def usage_me_series(
    since_hours: int = Query(24, ge=1, le=720),
    user: UserInfo = Depends(get_current_user),
):
    """Hourly buckets for account Usage page without org_observability."""
    if resolve_role(user) < Role.user:
        raise HTTPException(status_code=403, detail="Authentication required")
    scope = trace_scope_filters(user)
    su = scope.get("user_id", "") or ""
    so = scope.get("org_id", "") or ""
    st = scope.get("scope_tenant_id", "") or ""
    pl_series = await planner_usage_time_series(
        since_hours=since_hours,
        scope_user_id=su,
        scope_org_id=so,
        scope_tenant_id=st,
    )
    if pl_series and sum(b.get("requests", 0) for b in pl_series) > 0:
        return pl_series
    return []


@router.get("/me/requests")
async def usage_me_requests(
    since_hours: int = Query(720, ge=1, le=8760),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: UserInfo = Depends(get_current_user),
):
    """Privacy-safe per-request usage audit for the authenticated user."""
    if resolve_role(user) < Role.user:
        raise HTTPException(status_code=403, detail="Authentication required")
    uid = user.user_id or user.username
    return await list_user_usage_audit(uid, since_hours=since_hours, limit=limit, offset=offset)


@router.get("/me/requests/{request_id}")
async def usage_me_request_detail(
    request_id: str,
    user: UserInfo = Depends(get_current_user),
):
    """Privacy-safe request audit detail for one authenticated user's request."""
    if resolve_role(user) < Role.user:
        raise HTTPException(status_code=403, detail="Authentication required")
    uid = user.user_id or user.username
    row = await get_user_usage_audit_request(uid, request_id[:64])
    if row is None:
        raise HTTPException(status_code=404, detail="Usage request not found")
    return row


@router.get("/summary-unified")
async def usage_summary_unified(
    since_hours: int = Query(24, ge=1, le=720),
    user: UserInfo = Depends(get_current_user),
):
    """Pipeline metering + optional Yarn totals (org_admin+); glossary for UI."""
    _ensure_org_observability(user)
    return await get_summary_unified(user=user, since_hours=since_hours)
