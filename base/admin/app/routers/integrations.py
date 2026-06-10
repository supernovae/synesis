"""MCP tools and web search integration stats, log, and HITL policy management."""

from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import case, delete, func, select

from ..auth import CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SESSION_COOKIE_NAME, UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import KnowledgeGap, WebSearchLog, WebUrlPolicy
from ..rbac import RouteGroup, can_access_route_group, trace_scope_filters
from ..route_validation import validate_safe_identifier
from ..services import prometheus_client_svc as prom
from ..services.mcp_client import get_admin_mcp_tools, get_mcp_tools, probe_admin_mcp_health, probe_mcp_health
from ..services.outbound_security import validate_public_https_url

router = APIRouter(prefix="/api/v1/integrations", tags=["integrations"])

WebSearchOutcomeFilter = Literal["", "success", "error", "empty"]
_WEB_SEARCH_OUTCOME_VALUES = {"", "success", "error", "empty"}
WebSearchSourceSurfaceFilter = Literal[
    "",
    "yarn_chat",
    "yarn_mcp_http",
    "openwebui_planner",
    "planner_internal",
    "external_api",
    "unknown",
]
_WEB_SEARCH_SOURCE_SURFACE_VALUES = {
    "",
    "yarn_chat",
    "yarn_mcp_http",
    "openwebui_planner",
    "planner_internal",
    "external_api",
    "unknown",
}


def _clean_org_headers(org_headers: dict[str, str]) -> dict[str, str]:
    cleaned: dict[str, str] = {}
    for header_name in ("x-synesis-org-id", "x-active-org-id"):
        value = str(org_headers.get(header_name, "") or "").strip()
        if value:
            try:
                cleaned[header_name] = validate_safe_identifier(value, field_name=header_name, max_length=128)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
    return cleaned


UrlPolicyAction = Literal["allow", "block", "vetted"]

_FILTER_MAX_LENGTHS = {
    "domain": 256,
    "org_id": 256,
    "user_id": 256,
    "session_key": 256,
    "request_id": 128,
    "trace_id": 128,
    "tool_name": 64,
    "engine": 64,
    "q": 256,
}


def _ensure_org_content_admin(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_content_admin):
        raise HTTPException(status_code=403, detail="Requires org content admin access")


def _ensure_platform_control(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.platform_control):
        raise HTTPException(status_code=403, detail="Requires platform admin access")


def _sanitize_probe_payload(payload: dict) -> dict:
    allowed_errors = {"not_ready", "upstream_unhealthy", "request_failed", None}
    raw_error = payload.get("error")
    error = raw_error if raw_error in allowed_errors else "request_failed"
    return {
        "reachable": bool(payload.get("reachable", False)),
        "status_code": payload.get("status_code"),
        "latency_ms": payload.get("latency_ms"),
        "url": payload.get("url"),
        "error": error,
    }


def _apply_web_search_log_scope(stmt, user: UserInfo):
    """Constrain web-search log reads to the caller's server-derived scope."""
    scope = trace_scope_filters(user)
    if scope.get("org_id"):
        stmt = stmt.where(WebSearchLog.org_id == scope["org_id"])
    elif scope.get("user_id"):
        stmt = stmt.where(WebSearchLog.user_id == scope["user_id"])
    if scope.get("scope_tenant_id"):
        stmt = stmt.where(WebSearchLog.tenant_id == scope["scope_tenant_id"])
    return stmt


def _bounded_filter(value: str, *, field_name: str, max_length: int) -> str:
    normalized = (value or "").strip()
    if len(normalized) > max_length:
        raise HTTPException(status_code=422, detail=f"{field_name} must be at most {max_length} characters")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in normalized):
        raise HTTPException(status_code=422, detail=f"{field_name} must not contain control characters")
    return normalized


def _validate_web_search_log_filters(filters: dict[str, str]) -> dict[str, str]:
    return {
        field_name: _bounded_filter(value, field_name=field_name, max_length=max_length)
        for field_name, max_length in _FILTER_MAX_LENGTHS.items()
        for value in [filters.get(field_name, "")]
    }


# ── MCP ──


@router.get("/mcp/tools")
async def mcp_tools(_user: UserInfo = Depends(get_current_user)):
    tools = await get_mcp_tools()
    return {"tools": tools}


@router.get("/mcp/health")
async def mcp_agent_health(_user: UserInfo = Depends(get_current_user)):
    """Reachability of synesis-mcp (agent / IDE Streamable MCP)."""
    return _sanitize_probe_payload(await probe_mcp_health())


@router.get("/mcp/admin-mcp-health")
async def admin_mcp_streamable_health(_user: UserInfo = Depends(get_current_user)):
    """Reachability of synesis-admin-mcp-ts (Admin MCP, Streamable HTTP)."""
    return _sanitize_probe_payload(await probe_admin_mcp_health())


@router.get("/mcp/admin-catalog")
async def mcp_admin_tool_catalog(request: Request, user: UserInfo = Depends(get_current_user)):
    """Admin MCP tools (executed in admin API; MCP transport is synesis-admin-mcp-ts)."""
    auth_header = (request.headers.get("authorization") or "").strip()
    session_cookie = (request.cookies.get(SESSION_COOKIE_NAME) or "").strip()
    csrf_cookie = (request.cookies.get(CSRF_COOKIE_NAME) or "").strip()
    csrf_token = (request.headers.get(CSRF_HEADER_NAME) or request.headers.get("x-csrf-token") or "").strip()
    org_headers = _clean_org_headers(
        {
            "x-synesis-org-id": request.headers.get("x-synesis-org-id") or "",
            "x-active-org-id": request.headers.get("x-active-org-id") or "",
        }
    )
    ts_tools = await get_admin_mcp_tools(
        auth_header,
        org_headers,
        session_cookie=session_cookie,
        csrf_cookie=csrf_cookie,
        csrf_token=csrf_token,
    )
    return {"tools": ts_tools, "scope": "synesis-admin-mcp-ts"}


# ── Web search: aggregate stats (Prometheus) ──


@router.get("/web-search")
async def web_search_stats(_user: UserInfo = Depends(get_current_user)):
    """Web search aggregate stats — try Prometheus first, fall back to Postgres."""
    scope = trace_scope_filters(_user)
    stats = await prom.get_web_search_stats()
    if not scope and stats and stats.get("total", 0) > 0:
        return stats
    try:
        async with async_session() as session:
            stmt = select(
                func.count().label("total"),
                func.avg(WebSearchLog.latency_ms).label("avg_latency_ms"),
                func.sum(case((WebSearchLog.outcome == "error", 1), else_=0)).label("errors"),
            )
            row = (await session.execute(_apply_web_search_log_scope(stmt, _user))).one()
            total = int(row.total or 0)
            errors = int(row.errors or 0)
            return {
                "total": total,
                "avg_latency_ms": round(float(row.avg_latency_ms or 0), 1) if total else None,
                "error_rate": round(errors / total, 4) if total else None,
                "source": "postgres",
            }
    except Exception:
        return stats or {"total": 0, "avg_latency_ms": None, "error_rate": None}


# ── Web search: event log (Postgres) ──


@router.get("/web-search/log")
async def web_search_log(
    user: UserInfo = Depends(get_current_user),
    domain: str = Query("", max_length=256, description="Filter by domain"),
    outcome: WebSearchOutcomeFilter = Query("", description="Filter by outcome"),
    source_surface: WebSearchSourceSurfaceFilter = Query("", description="Filter by source surface"),
    org_id: str = Query("", max_length=256, description="Filter by org id"),
    user_id: str = Query("", max_length=256, description="Filter by user id"),
    session_key: str = Query("", max_length=256, description="Filter by session key"),
    request_id: str = Query("", max_length=128, description="Filter by request id"),
    trace_id: str = Query("", max_length=128, description="Filter by trace id"),
    tool_name: str = Query("", max_length=64, description="Filter by tool name"),
    engine: str = Query("", max_length=64, description="Filter by engine"),
    query_filter: str = Query("", alias="q", max_length=256, description="Substring search in query text"),
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=100),
):
    if outcome not in _WEB_SEARCH_OUTCOME_VALUES:
        raise HTTPException(status_code=422, detail="outcome must be a known web-search outcome")
    if source_surface not in _WEB_SEARCH_SOURCE_SURFACE_VALUES:
        raise HTTPException(status_code=422, detail="source_surface must be a known web-search surface")
    filters = _validate_web_search_log_filters(
        {
            "domain": domain,
            "org_id": org_id,
            "user_id": user_id,
            "session_key": session_key,
            "request_id": request_id,
            "trace_id": trace_id,
            "tool_name": tool_name,
            "engine": engine,
            "q": query_filter,
        }
    )
    domain = filters["domain"]
    org_id = filters["org_id"]
    user_id = filters["user_id"]
    session_key = filters["session_key"]
    request_id = filters["request_id"]
    trace_id = filters["trace_id"]
    tool_name = filters["tool_name"]
    engine = filters["engine"]
    query_filter = filters["q"]
    offset = (page - 1) * page_size
    async with async_session() as session:
        base = _apply_web_search_log_scope(select(WebSearchLog), user)
        if domain:
            base = base.where(WebSearchLog.domain == domain)
        if outcome:
            base = base.where(WebSearchLog.outcome == outcome)
        if source_surface:
            base = base.where(WebSearchLog.source_surface == source_surface)
        if org_id:
            base = base.where(WebSearchLog.org_id == org_id)
        if user_id:
            base = base.where(WebSearchLog.user_id == user_id)
        if session_key:
            base = base.where(WebSearchLog.session_key == session_key)
        if request_id:
            base = base.where(WebSearchLog.request_id == request_id)
        if trace_id:
            base = base.where(WebSearchLog.trace_id == trace_id)
        if tool_name:
            base = base.where(WebSearchLog.tool_name == tool_name)
        if engine:
            base = base.where(WebSearchLog.engine == engine)
        if query_filter:
            base = base.where(WebSearchLog.query.ilike(f"%{query_filter}%"))

        count_stmt = select(func.count()).select_from(base.subquery())
        total = (await session.execute(count_stmt)).scalar() or 0

        rows = (
            (await session.execute(base.order_by(WebSearchLog.timestamp.desc()).offset(offset).limit(page_size)))
            .scalars()
            .all()
        )

        items = [
            {
                "id": r.id,
                "timestamp": r.timestamp,
                "run_id": r.run_id,
                "query": r.query,
                "source_id": r.source_id,
                "profile": r.profile,
                "url": r.url,
                "domain": r.domain,
                "title": r.title,
                "snippet": r.snippet,
                "score": r.score,
                "latency_ms": r.latency_ms,
                "outcome": r.outcome,
                "engine": r.engine,
                "org_id": r.org_id,
                "user_id": r.user_id,
                "tenant_id": r.tenant_id,
                "request_id": r.request_id,
                "session_key": r.session_key,
                "conversation_id": r.conversation_id,
                "trace_id": r.trace_id,
                "source_surface": r.source_surface,
                "tool_name": r.tool_name,
                "query_hash": r.query_hash,
                "rate_bucket_key": r.rate_bucket_key,
                "blocked_reason": r.blocked_reason,
                "policy_action": r.policy_action,
                "token_estimate": r.token_estimate,
            }
            for r in rows
        ]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ── Web search: domain summary ──


@router.get("/web-search/log/domains")
async def web_search_domain_summary(
    user: UserInfo = Depends(get_current_user),
    limit: int = Query(50, ge=1, le=200),
):
    async with async_session() as session:
        stmt = _apply_web_search_log_scope(
            select(
                WebSearchLog.domain,
                func.count().label("count"),
                func.avg(WebSearchLog.latency_ms).label("avg_latency_ms"),
                func.max(WebSearchLog.timestamp).label("last_seen"),
                func.sum(case((WebSearchLog.outcome == "error", 1), else_=0)).label("error_count"),
            )
            .where(WebSearchLog.domain != "")
            .group_by(WebSearchLog.domain)
            .order_by(func.count().desc())
            .limit(limit),
            user,
        )
        rows = (await session.execute(stmt)).all()
        items = [
            {
                "domain": r.domain,
                "count": r.count,
                "avg_latency_ms": round(float(r.avg_latency_ms or 0), 1),
                "last_seen": r.last_seen,
                "error_count": int(r.error_count or 0),
            }
            for r in rows
        ]
    return {"domains": items}


# ── Web search: URL policies (HITL) ──


class PolicyCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    url_pattern: str = Field(..., min_length=1, max_length=2048)
    policy: UrlPolicyAction = "allow"
    reason: str = Field("", max_length=2000)
    boost_factor: float = Field(1.0, ge=0, le=10)
    auto_ingest: bool = False

    @field_validator("url_pattern")
    @classmethod
    def validate_url_pattern(cls, value: str) -> str:
        return _bounded_filter(value, field_name="url_pattern", max_length=2048)


@router.get("/web-search/policies")
async def list_policies(user: UserInfo = Depends(get_current_user)):
    _ensure_platform_control(user)
    async with async_session() as session:
        rows = (await session.execute(select(WebUrlPolicy).order_by(WebUrlPolicy.id.desc()))).scalars().all()
        items = [
            {
                "id": r.id,
                "url_pattern": r.url_pattern,
                "policy": r.policy,
                "reason": r.reason,
                "reviewed_by": r.reviewed_by,
                "reviewed_at": r.reviewed_at,
                "boost_factor": r.boost_factor,
                "auto_ingest": r.auto_ingest,
            }
            for r in rows
        ]
    return {"policies": items}


@router.post("/web-search/policies")
async def create_or_update_policy(
    body: PolicyCreate,
    user: UserInfo = Depends(get_current_user),
):
    _ensure_platform_control(user)
    async with async_session() as session:
        existing = (
            (await session.execute(select(WebUrlPolicy).where(WebUrlPolicy.url_pattern == body.url_pattern)))
            .scalars()
            .first()
        )

        if existing:
            existing.policy = body.policy
            existing.reason = body.reason
            existing.boost_factor = body.boost_factor
            existing.auto_ingest = body.auto_ingest
            existing.reviewed_by = user.username
            existing.reviewed_at = time.time()
        else:
            session.add(
                WebUrlPolicy(
                    url_pattern=body.url_pattern,
                    policy=body.policy,
                    reason=body.reason,
                    boost_factor=body.boost_factor,
                    auto_ingest=body.auto_ingest,
                    reviewed_by=user.username,
                    reviewed_at=time.time(),
                )
            )
        await session.commit()
    return {"ok": True}


@router.delete("/web-search/policies/{policy_id}")
async def delete_policy(
    policy_id: int,
    user: UserInfo = Depends(get_current_user),
):
    _ensure_platform_control(user)
    async with async_session() as session:
        await session.execute(delete(WebUrlPolicy).where(WebUrlPolicy.id == policy_id))
        await session.commit()
    return {"ok": True}


# ── Web search: ingest a URL into RAG ──


class IngestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    url: str = Field(..., min_length=1, max_length=2048)
    title: str = Field("", max_length=512)
    reason: str = Field("", max_length=2000)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        return _bounded_filter(value, field_name="url", max_length=2048)


@router.post("/web-search/ingest")
async def ingest_url(
    body: IngestRequest,
    user: UserInfo = Depends(get_current_user),
):
    """Queue a URL for RAG ingestion by creating a knowledge gap entry.

    The indexer's existing gap-resolution loop can pick this up, or a
    dedicated ingest worker can poll for gap_id prefix 'web-ingest-'.
    """
    import hashlib

    _ensure_platform_control(user)

    normalized_url = validate_public_https_url(body.url)
    gap_id = "web-ingest-" + hashlib.sha256(normalized_url.encode()).hexdigest()[:12]
    async with async_session() as session:
        existing = (await session.execute(select(KnowledgeGap).where(KnowledgeGap.gap_id == gap_id))).scalars().first()
        if not existing:
            session.add(
                KnowledgeGap(
                    gap_id=gap_id,
                    query=normalized_url,
                    task_description=f"Web ingest: {body.title or normalized_url}",
                    platform_context="web_ingest",
                    status="open",
                    web_search_fallback=False,
                    timestamp=time.time(),
                    resolved_by=user.username,
                    resolution_note=body.reason,
                )
            )
            await session.commit()
            return {"ok": True, "gap_id": gap_id, "created": True}
    return {"ok": True, "gap_id": gap_id, "created": False}
