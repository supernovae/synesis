"""Observability: health, cache, circuit breakers, failures, knowledge gaps."""

from __future__ import annotations

import logging
import os
import time
from asyncio import Lock, create_task
from datetime import UTC, datetime, timedelta

import httpx
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import delete, func, select, update

from ..auth import UserInfo, get_current_user, require_admin
from ..db.engine import async_session
from ..db.models import Failure, KnowledgeGap, YarnSessionEvent
from ..rbac import Role, effective_role, require_org_admin
from ..services import prometheus_client_svc as prom
from ..services.health_prober import probe_all
from ..services.token_economics_observability import (
    TOKEN_ECONOMICS_EVENT_KINDS,
    summarize_token_economics_events,
)

logger = logging.getLogger("synesis.admin.observability")

router = APIRouter(prefix="/api/v1/observability", tags=["observability"])

_HEALTH_CACHE_TTL_SECONDS = 15.0
_health_cache_lock = Lock()
_health_cache: dict[str, object] = {
    "services": [],
    "captured_at_epoch": 0.0,
    "refreshing": False,
}


async def _refresh_health_snapshot() -> None:
    services = await probe_all()
    async with _health_cache_lock:
        _health_cache["services"] = services
        _health_cache["captured_at_epoch"] = time.time()
        _health_cache["refreshing"] = False


@router.get("/health")
async def service_health(_user: UserInfo = Depends(get_current_user)):
    now = time.time()
    async with _health_cache_lock:
        cached_services = list(_health_cache.get("services") or [])
        captured_at = float(_health_cache.get("captured_at_epoch") or 0.0)
        refreshing = bool(_health_cache.get("refreshing"))
        stale = (now - captured_at) > _HEALTH_CACHE_TTL_SECONDS
        should_refresh = stale and not refreshing
        if should_refresh:
            _health_cache["refreshing"] = True

    if should_refresh:
        create_task(_refresh_health_snapshot())

    return {
        "services": cached_services,
        "captured_at_epoch": captured_at,
        "stale": stale,
        "refreshing": bool(_health_cache.get("refreshing")),
    }


@router.get("/cache")
async def cache_metrics(_user: UserInfo = Depends(require_org_admin)):
    return await prom.get_extended_cache_metrics()


@router.get("/cache/history")
async def cache_history(
    since_hours: int = Query(24, ge=1, le=720),
    service: str = Query("", description="Filter by service: planner, yarn"),
    _user: UserInfo = Depends(require_org_admin),
):
    """Time-series prefix cache snapshots from the database."""
    from ..db.models import PrefixCacheSnapshot

    cutoff = datetime.now(UTC) - timedelta(hours=since_hours)
    async with async_session() as session:
        stmt = select(PrefixCacheSnapshot).where(PrefixCacheSnapshot.captured_at >= cutoff)
        if service:
            stmt = stmt.where(PrefixCacheSnapshot.service == service)
        stmt = stmt.order_by(PrefixCacheSnapshot.captured_at.asc()).limit(500)
        result = await session.execute(stmt)
        rows = result.scalars().all()

    return {
        "snapshots": [
            {
                "service": r.service,
                "captured_at": r.captured_at.isoformat() if r.captured_at else None,
                "prompt_tokens": r.prompt_tokens,
                "cached_prompt_tokens": r.cached_prompt_tokens,
                "hit_rate": r.hit_rate,
                "cache_mode": r.cache_mode,
                "requests": r.requests,
                "estimated_savings_usd": r.estimated_savings_usd,
            }
            for r in rows
        ],
        "count": len(rows),
        "since_hours": since_hours,
        "service": service or "all",
    }


@router.get("/cache/token-economics")
async def token_economics_metrics(
    since_hours: int = Query(24, ge=1, le=720),
    limit: int = Query(5000, ge=100, le=50000),
    _user: UserInfo = Depends(require_org_admin),
):
    """Roll up Yarn token-economics and cache-policy decision events."""
    role = effective_role(_user)
    caller_org = (_user.org_id or "").strip()
    scope = "platform" if role >= Role.platform_admin else f"org:{caller_org or 'none'}"
    cutoff = datetime.now(UTC) - timedelta(hours=since_hours)

    if role < Role.platform_admin and not caller_org:
        summary = summarize_token_economics_events([], since_hours=since_hours, scope=scope)
        summary["limit"] = limit
        return summary

    async with async_session() as session:
        stmt = select(YarnSessionEvent).where(
            YarnSessionEvent.created_at >= cutoff,
            YarnSessionEvent.event_kind.in_(TOKEN_ECONOMICS_EVENT_KINDS),
        )
        if role < Role.platform_admin:
            stmt = stmt.where(YarnSessionEvent.org_id == caller_org)
        stmt = stmt.order_by(YarnSessionEvent.created_at.desc()).limit(limit)
        result = await session.execute(stmt)
        rows = list(result.scalars().all())

    summary = summarize_token_economics_events(rows, since_hours=since_hours, scope=scope)
    summary["limit"] = limit
    return summary


@router.get("/compaction")
async def compaction_metrics(
    since_hours: int = Query(24, ge=1, le=720),
    service: str = Query("", description="Filter by service: planner, yarn"),
    _user: UserInfo = Depends(get_current_user),
):
    """Time-series compaction snapshots from the database."""
    from ..db.models import CompactionSnapshot

    cutoff = datetime.now(UTC) - timedelta(hours=since_hours)
    async with async_session() as session:
        stmt = select(CompactionSnapshot).where(CompactionSnapshot.captured_at >= cutoff)
        if service:
            stmt = stmt.where(CompactionSnapshot.service == service)
        stmt = stmt.order_by(CompactionSnapshot.captured_at.asc()).limit(500)
        result = await session.execute(stmt)
        rows = result.scalars().all()

    return {
        "snapshots": [
            {
                "service": r.service,
                "captured_at": r.captured_at.isoformat() if r.captured_at else None,
                "compaction_count": r.compaction_count,
                "chars_before": r.chars_before,
                "chars_after": r.chars_after,
                "tokens_saved_estimate": r.tokens_saved_estimate,
                "errors": r.errors,
                "detail": r.detail,
            }
            for r in rows
        ],
        "count": len(rows),
        "since_hours": since_hours,
        "service": service or "all",
    }


@router.get("/authz")
async def authz_stats(_user: UserInfo = Depends(get_current_user)):
    """Authorization engine stats (deterministic or OpenFGA shadow)."""
    from ..services.authz_engine import create_authz_engine

    engine = create_authz_engine()
    return engine.get_stats()


@router.get("/circuit-breakers")
async def circuit_breakers(_user: UserInfo = Depends(require_org_admin)):
    breakers = await prom.get_circuit_breaker_metrics()
    return {"breakers": breakers}


# ── Failures (Postgres) ──


@router.get("/failures")
async def failure_list(
    _user: UserInfo = Depends(require_org_admin),
    language: str = Query("", description="Filter by language"),
    error_type: str = Query("", description="Filter by error type"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    offset = (page - 1) * page_size
    async with async_session() as session:
        base = select(Failure)
        if language:
            base = base.where(Failure.language == language)
        if error_type:
            base = base.where(Failure.error_type == error_type)
        count_stmt = select(func.count()).select_from(base.subquery())
        total = (await session.execute(count_stmt)).scalar() or 0
        stmt = base.order_by(Failure.timestamp.desc()).offset(offset).limit(page_size)
        result = await session.execute(stmt)
        rows = result.scalars().all()

    failures = [
        {
            "failure_id": r.failure_id,
            "code": r.code,
            "error_output": r.error_output,
            "exit_code": r.exit_code,
            "error_type": r.error_type,
            "language": r.language,
            "task_description": r.task_description,
            "resolution": r.resolution,
            "timestamp": r.timestamp,
        }
        for r in rows
    ]
    return {"failures": failures, "total": total}


@router.get("/failures/stats")
async def failure_stats(_user: UserInfo = Depends(require_org_admin)):
    async with async_session() as session:
        total_stmt = select(func.count()).select_from(Failure)
        total = (await session.execute(total_stmt)).scalar() or 0

        by_lang = await session.execute(
            select(Failure.language, func.count()).where(Failure.language != "").group_by(Failure.language)
        )
        by_language = {r[0]: r[1] for r in by_lang}

        by_etype = await session.execute(
            select(Failure.error_type, func.count()).where(Failure.error_type != "").group_by(Failure.error_type)
        )
        by_error_type = {r[0]: r[1] for r in by_etype}

        resolved_stmt = select(func.count()).select_from(Failure).where(Failure.resolution != "")
        resolved = (await session.execute(resolved_stmt)).scalar() or 0

    return {
        "total_failures": total,
        "resolved": resolved,
        "unresolved": total - resolved,
        "by_language": by_language,
        "by_error_type": by_error_type,
    }


@router.get("/failures/{failure_id}")
async def failure_detail(
    failure_id: str,
    _user: UserInfo = Depends(get_current_user),
):
    async with async_session() as session:
        stmt = select(Failure).where(Failure.failure_id == failure_id).limit(1)
        result = await session.execute(stmt)
        row = result.scalar_one_or_none()
    if not row:
        return {"error": "not found"}
    return {
        "failure_id": row.failure_id,
        "code": row.code,
        "error_output": row.error_output,
        "exit_code": row.exit_code,
        "error_type": row.error_type,
        "language": row.language,
        "task_description": row.task_description,
        "resolution": row.resolution,
        "timestamp": row.timestamp,
    }


@router.delete("/failures/{failure_id}")
async def delete_failure(
    failure_id: str,
    _user: UserInfo = Depends(require_admin),
):
    async with async_session() as session:
        stmt = delete(Failure).where(Failure.failure_id == failure_id[:64])
        result = await session.execute(stmt)
        await session.commit()
    return {"deleted": int(result.rowcount or 0), "failure_id": failure_id[:64]}


class FailureBulkDeleteRequest(BaseModel):
    failure_ids: list[str]


@router.post("/failures/bulk-delete")
async def bulk_delete_failures(
    req: FailureBulkDeleteRequest,
    _user: UserInfo = Depends(require_admin),
):
    ids = [str(x)[:64] for x in req.failure_ids if str(x).strip()]
    if not ids:
        return {"deleted": 0, "requested": 0}
    async with async_session() as session:
        stmt = delete(Failure).where(Failure.failure_id.in_(ids))
        result = await session.execute(stmt)
        await session.commit()
    return {"deleted": int(result.rowcount or 0), "requested": len(ids)}


@router.delete("/failures")
async def purge_failures(
    resolved_only: bool = Query(True),
    _user: UserInfo = Depends(require_admin),
):
    async with async_session() as session:
        stmt = delete(Failure)
        if resolved_only:
            stmt = stmt.where(Failure.resolution != "")
        result = await session.execute(stmt)
        await session.commit()
    return {"deleted": int(result.rowcount or 0), "resolved_only": resolved_only}


# ── Knowledge Gaps (Postgres) ──


def _gap_to_dict(g: KnowledgeGap) -> dict:
    """Convert KnowledgeGap ORM to API response (chunk_id for backward compat)."""
    return {
        "chunk_id": g.gap_id,
        "gap_id": g.gap_id,
        "query": g.query,
        "task_description": g.task_description,
        "collections_queried": g.collections_queried,
        "max_score": g.max_score,
        "platform_context": g.platform_context,
        "language": g.language,
        "status": g.status,
        "resolved_at": g.resolved_at,
        "resolved_by": g.resolved_by,
        "resolution_note": g.resolution_note,
        "web_search_fallback": g.web_search_fallback,
        "timestamp": g.timestamp,
    }


@router.get("/knowledge-gaps")
async def knowledge_gaps(
    _user: UserInfo = Depends(require_org_admin),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query("", description="Filter by status: open, resolved, reopened"),
):
    """List queries where RAG confidence was below threshold, signaling corpus gaps."""
    offset = (page - 1) * page_size
    async with async_session() as session:
        base = select(KnowledgeGap)
        if status:
            base = base.where(KnowledgeGap.status == status)
        total = (await session.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
        stmt = base.order_by(KnowledgeGap.timestamp.desc()).offset(offset).limit(page_size)
        result = await session.execute(stmt)
        rows = result.scalars().all()

    gaps = [_gap_to_dict(g) for g in rows]
    return {"gaps": gaps, "total": total}


@router.get("/knowledge-gaps/stats")
async def knowledge_gap_stats(_user: UserInfo = Depends(require_org_admin)):
    """Aggregate stats on RAG corpus gaps for prioritization."""
    async with async_session() as session:
        total_stmt = select(func.count()).select_from(KnowledgeGap)
        total = (await session.execute(total_stmt)).scalar() or 0
        if total == 0:
            return {
                "total_gaps": 0,
                "avg_score": 0,
                "by_context": {},
                "by_language": {},
                "by_status": {},
            }

        avg_stmt = select(func.avg(KnowledgeGap.max_score)).select_from(KnowledgeGap)
        avg_score = (await session.execute(avg_stmt)).scalar() or 0.0

        by_ctx = await session.execute(
            select(KnowledgeGap.platform_context, func.count())
            .where(KnowledgeGap.platform_context != "")
            .group_by(KnowledgeGap.platform_context)
        )
        by_context = {r[0]: r[1] for r in by_ctx}

        by_lang = await session.execute(
            select(KnowledgeGap.language, func.count())
            .where(KnowledgeGap.language != "")
            .group_by(KnowledgeGap.language)
        )
        by_language = {r[0]: r[1] for r in by_lang}

        by_st = await session.execute(select(KnowledgeGap.status, func.count()).group_by(KnowledgeGap.status))
        by_status = {r[0]: r[1] for r in by_st}

    return {
        "total_gaps": total,
        "avg_score": round(float(avg_score), 4),
        "by_context": by_context,
        "by_language": by_language,
        "by_status": by_status,
    }


# ── Knowledge Gap Lifecycle Actions ──


class GapResolveRequest(BaseModel):
    resolution_note: str = ""


@router.post("/knowledge-gaps/{chunk_id}/resolve")
async def resolve_gap(
    chunk_id: str,
    req: GapResolveRequest | None = None,
    user: UserInfo = Depends(require_admin),
):
    """Mark a knowledge gap as resolved/satisfied."""
    note = req.resolution_note if req else ""
    now = float(time.time())
    async with async_session() as session:
        stmt = (
            update(KnowledgeGap)
            .where(KnowledgeGap.gap_id == chunk_id[:64])
            .values(
                status="resolved",
                resolved_at=now,
                resolved_by=user.username[:128],
                resolution_note=note[:8192],
            )
        )
        result = await session.execute(stmt)
        await session.commit()
    if result.rowcount and result.rowcount > 0:
        return {"status": "resolved", "chunk_id": chunk_id}
    return {"error": "failed to update status"}


@router.post("/knowledge-gaps/{chunk_id}/reopen")
async def reopen_gap(
    chunk_id: str,
    user: UserInfo = Depends(require_admin),
):
    """Reopen a previously resolved knowledge gap."""
    async with async_session() as session:
        stmt = (
            update(KnowledgeGap)
            .where(KnowledgeGap.gap_id == chunk_id[:64])
            .values(
                status="reopened",
                resolved_at=0.0,
                resolved_by="",
                resolution_note="",
            )
        )
        result = await session.execute(stmt)
        await session.commit()
    if result.rowcount and result.rowcount > 0:
        return {"status": "reopened", "chunk_id": chunk_id}
    return {"error": "failed to update status"}


@router.delete("/knowledge-gaps/{chunk_id}")
async def purge_gap(
    chunk_id: str,
    _user: UserInfo = Depends(require_admin),
):
    """Permanently delete a knowledge gap and its status record."""
    async with async_session() as session:
        stmt = delete(KnowledgeGap).where(KnowledgeGap.gap_id == chunk_id[:64])
        await session.execute(stmt)
        await session.commit()
    return {"status": "purged", "chunk_id": chunk_id}


class GapBulkActionRequest(BaseModel):
    gap_ids: list[str]
    action: str
    resolution_note: str = ""


@router.post("/knowledge-gaps/bulk-action")
async def bulk_action_gaps(
    req: GapBulkActionRequest,
    user: UserInfo = Depends(require_admin),
):
    ids = [str(x)[:64] for x in req.gap_ids if str(x).strip()]
    if not ids:
        return {"updated": 0, "requested": 0, "action": req.action}
    now = float(time.time())
    async with async_session() as session:
        if req.action == "resolve":
            stmt = (
                update(KnowledgeGap)
                .where(KnowledgeGap.gap_id.in_(ids))
                .values(
                    status="resolved",
                    resolved_at=now,
                    resolved_by=user.username[:128],
                    resolution_note=req.resolution_note[:8192],
                )
            )
        elif req.action == "reopen":
            stmt = (
                update(KnowledgeGap)
                .where(KnowledgeGap.gap_id.in_(ids))
                .values(status="reopened", resolved_at=0.0, resolved_by="", resolution_note="")
            )
        elif req.action == "purge":
            result = await session.execute(delete(KnowledgeGap).where(KnowledgeGap.gap_id.in_(ids)))
            await session.commit()
            return {"updated": int(result.rowcount or 0), "requested": len(ids), "action": req.action}
        else:
            return {"updated": 0, "requested": len(ids), "action": req.action, "error": "unsupported_action"}
        result = await session.execute(stmt)
        await session.commit()
    return {"updated": int(result.rowcount or 0), "requested": len(ids), "action": req.action}


@router.delete("/knowledge-gaps")
async def purge_gaps(
    status: str = Query("resolved"),
    _user: UserInfo = Depends(require_admin),
):
    async with async_session() as session:
        stmt = delete(KnowledgeGap).where(KnowledgeGap.status == status)
        result = await session.execute(stmt)
        await session.commit()
    return {"deleted": int(result.rowcount or 0), "status": status}


class GapValidateRequest(BaseModel):
    score_threshold: float = 0.6
    max_gaps: int = 200


class GapValidateResponse(BaseModel):
    validated: int = 0
    still_open: int = 0
    errors: int = 0
    details: list[dict] = []


_EMBEDDER_URL = os.getenv(
    "SYNESIS_EMBEDDER_URL",
    "http://embedder.synesis-rag.svc.cluster.local:8080",
)


async def _embed_query(text: str) -> list[float] | None:
    """Embed a gap query on-the-fly via TEI."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{_EMBEDDER_URL.rstrip('/')}/v1/embeddings",
                json={"input": [text[:2048]], "model": "BAAI/bge-m3"},
            )
            resp.raise_for_status()
            data = resp.json()
            return data["data"][0]["embedding"]
    except Exception as exc:
        logger.warning("embed_query_failed", extra={"error": str(exc)[:120]})
        return None


@router.post("/knowledge-gaps/validate", response_model=GapValidateResponse)
async def validate_knowledge_gaps(
    req: GapValidateRequest | None = None,
    user: UserInfo = Depends(require_admin),
):
    """Re-query RAG for open knowledge gaps and auto-resolve satisfied ones.

    For each open/reopened gap, embeds the query via TEI and runs a vector
    similarity search against the NornicDB content graph. If the top hit score exceeds
    the threshold, the gap is auto-resolved.
    """
    threshold = req.score_threshold if req else 0.6
    max_gaps = req.max_gaps if req else 200

    try:
        from ..services.nornic_service import safe_vector_search
    except ImportError:
        return GapValidateResponse(
            errors=1,
            details=[
                {"status": "error", "reason": "NornicDB client not available; vector search required for validation."}
            ],
        )

    async with async_session() as session:
        stmt = (
            select(KnowledgeGap)
            .where(KnowledgeGap.status.in_(["open", "reopened"]))
            .order_by(KnowledgeGap.timestamp.desc())
            .limit(max_gaps)
        )
        result = await session.execute(stmt)
        open_gaps = result.scalars().all()

    if not open_gaps:
        return GapValidateResponse()

    validated = 0
    still_open = 0
    errors = 0
    details: list[dict] = []

    for gap in open_gaps:
        chunk_id = gap.gap_id
        query = gap.query or ""

        embedding = await _embed_query(query)
        if not embedding:
            errors += 1
            details.append({"chunk_id": chunk_id, "status": "error", "reason": "embedding_failed"})
            continue

        try:
            hits = safe_vector_search(
                "content_graph",
                vector=embedding,
                top_k=1,
                output_fields=["chunk_id", "text", "source_url"],
                is_platform_admin=True,
            )
        except Exception as exc:
            errors += 1
            details.append({"chunk_id": chunk_id, "status": "error", "reason": str(exc)[:120]})
            continue

        if hits:
            top_distance = hits[0].get("distance", 0.0)
            top_score = 1.0 - top_distance if top_distance < 1.0 else 0.0

            if top_score >= threshold:
                async with async_session() as session:
                    stmt = (
                        update(KnowledgeGap)
                        .where(KnowledgeGap.gap_id == chunk_id[:64])
                        .values(
                            status="resolved",
                            resolved_at=float(time.time()),
                            resolved_by=user.username[:128],
                            resolution_note=f"auto-validated: RAG score {top_score:.3f}",
                        )
                    )
                    await session.execute(stmt)
                    await session.commit()
                validated += 1
                details.append(
                    {
                        "chunk_id": chunk_id,
                        "status": "validated",
                        "score": round(top_score, 3),
                        "query": query[:80],
                    }
                )
            else:
                still_open += 1
                details.append(
                    {
                        "chunk_id": chunk_id,
                        "status": "still_open",
                        "score": round(top_score, 3),
                        "query": query[:80],
                    }
                )
        else:
            still_open += 1
            details.append(
                {
                    "chunk_id": chunk_id,
                    "status": "still_open",
                    "score": 0.0,
                    "query": query[:80],
                }
            )

    logger.info(
        "knowledge_gaps_validated",
        extra={
            "validated": validated,
            "still_open": still_open,
            "errors": errors,
            "total_checked": len(open_gaps),
            "threshold": threshold,
        },
    )
    return GapValidateResponse(
        validated=validated,
        still_open=still_open,
        errors=errors,
        details=details,
    )


# ── OpenFGA Authorization Status ─────────────────────────────────────────────


class FgaStatusResponse(BaseModel):
    engine: str
    openfga_configured: bool
    evaluations: int
    rejections: int
    recent_events: list[dict]


@router.get("/fga-status", response_model=FgaStatusResponse)
async def fga_status(_admin: UserInfo = Depends(require_admin)):
    """Return OpenFGA authorization engine status and recent evaluation events."""
    from ..services.authz_engine import create_authz_engine

    engine = create_authz_engine()
    stats = engine.get_stats()
    return FgaStatusResponse(
        engine=stats["engine"],
        openfga_configured=stats["openfga_configured"],
        evaluations=stats["evaluations"],
        rejections=stats["rejections"],
        recent_events=stats["recent_events"],
    )


class TokenFgaExplanation(BaseModel):
    """Explains how PAT scopes relate to FGA relationships for the current user."""

    scopes: list[str]
    fga_relations_explain: list[str]


@router.get("/token-fga-explain", response_model=TokenFgaExplanation)
async def token_fga_explain(user: UserInfo = Depends(get_current_user)):
    """Explain the FGA relationship implications of the current user's token scopes."""
    scopes = user.token_scopes or []
    explain: list[str] = []

    if not scopes:
        explain.append("JWT session: all FGA relationships apply based on user identity (no scope restriction)")
    else:
        if any(s.startswith("model") for s in scopes):
            explain.append(
                "model scope: grants planner_endpoint:chat_completions#can_invoke + rag_catalog:default#can_read_public"
            )
        if any(s.startswith("coder") for s in scopes):
            explain.append(
                "coder scope: grants yarn_endpoint:completions#can_invoke + yarn_endpoint:messages#can_invoke"
            )
        if not any(s.startswith("model") for s in scopes) and not any(s.startswith("coder") for s in scopes):
            explain.append("token has no recognized scope prefix: FGA invocation checks will likely fail")

    if user.org_id:
        explain.append(f"org context: org:{user.org_id}#member — enables org-scoped RAG and admin access")
    else:
        explain.append("no org context: solo user — FGA grants public catalog access only")

    return TokenFgaExplanation(scopes=scopes, fga_relations_explain=explain)
