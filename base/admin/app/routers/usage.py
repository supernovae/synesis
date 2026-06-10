"""Usage endpoints — planner_usage_log primary; trace aggregates fallback."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request

from ..auth import UserInfo, get_current_user
from ..rbac import Role, RouteGroup, can_access_route_group, resolve_role, trace_scope_filters
from ..route_validation import SAFE_IDENTIFIER_PATTERN
from ..services.account_usage_service import account_usage_identity_candidates, build_account_usage_dashboard
from ..services.planner_usage_service import aggregate_planner_usage_period, planner_usage_time_series
from ..services.trace_store import aggregate_traces_period, trace_time_series
from ..services.usage_audit_service import get_user_usage_audit_request_for_ids, list_user_usage_audit
from ..services.usage_unified import get_summary_unified

router = APIRouter(prefix="/api/v1/usage", tags=["usage"])


def _ensure_org_observability(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_observability):
        raise HTTPException(status_code=403, detail="Requires route group access: org_observability")


def _account_usage_user_ids(user: UserInfo, request: Request) -> list[str]:
    """Return self-scoped metering identities for account usage views."""
    extra = [getattr(request.state, "yarn_bearer_user_id", "")]
    return account_usage_identity_candidates(user, extra)


def _normalize_usage_summary(pl: dict, trace_fb: dict | None, *, include_provider_actual: bool = False) -> dict:
    """Normalize org-observability usage to public price vocabulary."""
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
        "price_usd": float(src.get("estimated_cost_usd", 0) or 0),
        "no_cache_price_usd": float(src.get("estimated_no_cache_cost_usd", 0) or 0),
        "cache_discount_usd": float(src.get("cache_savings_usd", 0) or 0),
        "avg_duration_ms": float(src.get("avg_duration_ms", 0) or 0),
        "error_count": int(src.get("error_count", 0)),
        "source": src.get("source", "planner_usage_log"),
    }
    if include_provider_actual:
        out["provider_actual_cost_usd"] = float(src.get("actual_cost_usd", 0) or 0)
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
    return _normalize_usage_summary(
        pl,
        tr,
        include_provider_actual=resolve_role(user) >= Role.platform_admin,
    )


def _normalize_usage_series(rows: list[dict], *, include_provider_actual: bool = False) -> list[dict]:
    normalized: list[dict] = []
    for row in rows:
        item = {
            "bucket": row.get("bucket", ""),
            "requests": int(row.get("requests", 0) or 0),
            "total_tokens": int(row.get("total_tokens", 0) or 0),
            "tokens_in": int(row.get("tokens_in", 0) or 0),
            "tokens_cached": int(row.get("tokens_cached", 0) or 0),
            "tokens_cache_write": int(row.get("tokens_cache_write", 0) or 0),
            "price_usd": float(row.get("estimated_cost_usd", 0) or 0),
            "no_cache_price_usd": float(row.get("estimated_no_cache_cost_usd", 0) or 0),
            "cache_discount_usd": float(row.get("cache_savings_usd", 0) or 0),
            "avg_duration_ms": float(row.get("avg_duration_ms", 0) or 0),
            "error_count": int(row.get("error_count", 0) or 0),
        }
        if include_provider_actual:
            item["provider_actual_cost_usd"] = float(row.get("actual_cost_usd", 0) or 0)
        normalized.append(item)
    return normalized


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
    include_provider_actual = resolve_role(_user) >= Role.platform_admin
    if pl_series and sum(b.get("requests", 0) for b in pl_series) > 0:
        return _normalize_usage_series(pl_series, include_provider_actual=include_provider_actual)
    trace_series = await trace_time_series(
        since_hours=since_hours,
        scope_user_id=su,
        scope_org_id=so,
        scope_tenant_id=st,
    )
    return _normalize_usage_series(trace_series, include_provider_actual=include_provider_actual)


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
    request: Request,
    since_hours: int = Query(24, ge=1, le=720),
    user: UserInfo = Depends(get_current_user),
):
    """Price-only self usage totals for any authenticated user."""
    if resolve_role(user) < Role.user:
        raise HTTPException(status_code=403, detail="Authentication required")
    dashboard = await build_account_usage_dashboard(_account_usage_user_ids(user, request), since_hours=since_hours)
    return {"period_hours": since_hours, **dashboard["summary"]["total"], "price_basis": dashboard["price_basis"]}


@router.get("/me/series")
async def usage_me_series(
    request: Request,
    since_hours: int = Query(24, ge=1, le=720),
    user: UserInfo = Depends(get_current_user),
):
    """Price-only hourly buckets for account Usage page without org_observability."""
    if resolve_role(user) < Role.user:
        raise HTTPException(status_code=403, detail="Authentication required")
    dashboard = await build_account_usage_dashboard(_account_usage_user_ids(user, request), since_hours=since_hours)
    return dashboard["series"]


@router.get("/me/dashboard")
async def usage_me_dashboard(
    request: Request,
    since_hours: int = Query(24, ge=1, le=8760),
    user: UserInfo = Depends(get_current_user),
):
    """Self-scoped Chat + Coder usage dashboard for the authenticated account."""
    if resolve_role(user) < Role.user:
        raise HTTPException(status_code=403, detail="Authentication required")
    return await build_account_usage_dashboard(
        _account_usage_user_ids(user, request),
        since_hours=since_hours,
    )


@router.get("/me/requests")
async def usage_me_requests(
    request: Request,
    since_hours: int = Query(720, ge=1, le=8760),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: UserInfo = Depends(get_current_user),
):
    """Privacy-safe per-request usage audit for the authenticated user."""
    if resolve_role(user) < Role.user:
        raise HTTPException(status_code=403, detail="Authentication required")
    uid = user.user_id or user.username
    return await list_user_usage_audit(
        uid,
        user_ids=_account_usage_user_ids(user, request),
        since_hours=since_hours,
        limit=limit,
        offset=offset,
    )


@router.get("/me/requests/{request_id}")
async def usage_me_request_detail(
    request: Request,
    request_id: str = Path(..., min_length=1, max_length=64, pattern=SAFE_IDENTIFIER_PATTERN),
    user: UserInfo = Depends(get_current_user),
):
    """Privacy-safe request audit detail for one authenticated user's request."""
    if resolve_role(user) < Role.user:
        raise HTTPException(status_code=403, detail="Authentication required")
    row = await get_user_usage_audit_request_for_ids(_account_usage_user_ids(user, request), request_id)
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
