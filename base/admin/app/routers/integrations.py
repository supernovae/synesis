"""MCP tools and web search integration stats, log, and HITL policy management."""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import case, delete, func, select

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import KnowledgeGap, WebSearchLog, WebUrlPolicy
from ..rbac import Role, resolve_role
from ..routers import admin_mcp
from ..services import prometheus_client_svc as prom
from ..services.mcp_client import get_mcp_tools, probe_mcp_health

router = APIRouter(prefix="/api/v1/integrations", tags=["integrations"])


# ── MCP ──


@router.get("/mcp/tools")
async def mcp_tools(_user: UserInfo = Depends(get_current_user)):
    tools = await get_mcp_tools()
    return {"tools": tools}


@router.get("/mcp/health")
async def mcp_agent_health(_user: UserInfo = Depends(get_current_user)):
    """Reachability of synesis-mcp (Yarn / IDE agent tools)."""
    try:
        await probe_mcp_health()
        return {"ok": True, "status": "ok"}
    except Exception:
        return {"ok": False, "status": "error", "detail": "mcp_health_probe_failed"}


@router.get("/mcp/admin-catalog")
async def mcp_admin_tool_catalog(user: UserInfo = Depends(get_current_user)):
    """Admin MCP (HTTP) tools: full list with required roles for platform admins; otherwise caller-visible subset."""
    role = resolve_role(user)
    if role >= Role.platform_admin:
        return {"tools": admin_mcp.catalog_all_tools(), "scope": "full"}
    return {
        "tools": admin_mcp.visible_tools_for_role(role),
        "scope": "visible",
        "note": "platform_admin sees all tools with min_role; call via POST /api/v1/mcp/tools/call with Bearer token",
    }


# ── Web search: aggregate stats (Prometheus) ──


@router.get("/web-search")
async def web_search_stats(_user: UserInfo = Depends(get_current_user)):
    """Web search aggregate stats — try Prometheus first, fall back to Postgres."""
    stats = await prom.get_web_search_stats()
    if stats and stats.get("total", 0) > 0:
        return stats
    try:
        async with async_session() as session:
            row = (
                await session.execute(
                    select(
                        func.count().label("total"),
                        func.avg(WebSearchLog.latency_ms).label("avg_latency_ms"),
                        func.sum(case((WebSearchLog.outcome == "error", 1), else_=0)).label("errors"),
                    )
                )
            ).one()
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
    _user: UserInfo = Depends(get_current_user),
    domain: str = Query("", description="Filter by domain"),
    outcome: str = Query("", description="Filter by outcome"),
    query_filter: str = Query("", alias="q", description="Substring search in query text"),
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=100),
):
    offset = (page - 1) * page_size
    async with async_session() as session:
        base = select(WebSearchLog)
        if domain:
            base = base.where(WebSearchLog.domain == domain)
        if outcome:
            base = base.where(WebSearchLog.outcome == outcome)
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
            }
            for r in rows
        ]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ── Web search: domain summary ──


@router.get("/web-search/log/domains")
async def web_search_domain_summary(
    _user: UserInfo = Depends(get_current_user),
    limit: int = Query(50, ge=1, le=200),
):
    async with async_session() as session:
        stmt = (
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
            .limit(limit)
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
    url_pattern: str
    policy: str = "allow"
    reason: str = ""
    boost_factor: float = 1.0
    auto_ingest: bool = False


@router.get("/web-search/policies")
async def list_policies(_user: UserInfo = Depends(get_current_user)):
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
    _user: UserInfo = Depends(get_current_user),
):
    async with async_session() as session:
        await session.execute(delete(WebUrlPolicy).where(WebUrlPolicy.id == policy_id))
        await session.commit()
    return {"ok": True}


# ── Web search: ingest a URL into RAG ──


class IngestRequest(BaseModel):
    url: str
    title: str = ""
    reason: str = ""


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

    gap_id = "web-ingest-" + hashlib.sha256(body.url.encode()).hexdigest()[:12]
    async with async_session() as session:
        existing = (await session.execute(select(KnowledgeGap).where(KnowledgeGap.gap_id == gap_id))).scalars().first()
        if not existing:
            session.add(
                KnowledgeGap(
                    gap_id=gap_id,
                    query=body.url,
                    task_description=f"Web ingest: {body.title or body.url}",
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
