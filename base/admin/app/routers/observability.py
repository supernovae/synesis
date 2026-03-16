"""Observability: health, cache, circuit breakers, failures, knowledge gaps."""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserInfo, get_current_user, require_admin
from ..db.engine import async_session
from ..db.models import Failure, KnowledgeGap
from ..services import prometheus_client_svc as prom
from ..services.health_prober import probe_all

logger = logging.getLogger("synesis.admin.observability")

router = APIRouter(prefix="/api/v1/observability", tags=["observability"])


@router.get("/health")
async def service_health(_user: UserInfo = Depends(get_current_user)):
    services = await probe_all()
    return {"services": services}


@router.get("/cache")
async def cache_metrics(_user: UserInfo = Depends(get_current_user)):
    return await prom.get_extended_cache_metrics()


@router.get("/circuit-breakers")
async def circuit_breakers(_user: UserInfo = Depends(get_current_user)):
    breakers = await prom.get_circuit_breaker_metrics()
    return {"breakers": breakers}


# ── Failures (Postgres) ──


@router.get("/failures")
async def failure_list(
    _user: UserInfo = Depends(get_current_user),
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
async def failure_stats(_user: UserInfo = Depends(get_current_user)):
    async with async_session() as session:
        total_stmt = select(func.count()).select_from(Failure)
        total = (await session.execute(total_stmt)).scalar() or 0

        by_lang = (
            await session.execute(
                select(Failure.language, func.count())
                .where(Failure.language != "")
                .group_by(Failure.language)
            )
        )
        by_language = {r[0]: r[1] for r in by_lang}

        by_etype = (
            await session.execute(
                select(Failure.error_type, func.count())
                .where(Failure.error_type != "")
                .group_by(Failure.error_type)
            )
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
    _user: UserInfo = Depends(get_current_user),
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
async def knowledge_gap_stats(_user: UserInfo = Depends(get_current_user)):
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

        by_ctx = (
            await session.execute(
                select(KnowledgeGap.platform_context, func.count())
                .where(KnowledgeGap.platform_context != "")
                .group_by(KnowledgeGap.platform_context)
            )
        )
        by_context = {r[0]: r[1] for r in by_ctx}

        by_lang = (
            await session.execute(
                select(KnowledgeGap.language, func.count())
                .where(KnowledgeGap.language != "")
                .group_by(KnowledgeGap.language)
            )
        )
        by_language = {r[0]: r[1] for r in by_lang}

        by_st = (
            await session.execute(
                select(KnowledgeGap.status, func.count()).group_by(KnowledgeGap.status)
            )
        )
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


class GapValidateRequest(BaseModel):
    score_threshold: float = 0.6
    max_gaps: int = 200


class GapValidateResponse(BaseModel):
    validated: int = 0
    still_open: int = 0
    errors: int = 0
    details: list[dict] = []


@router.post("/knowledge-gaps/validate", response_model=GapValidateResponse)
async def validate_knowledge_gaps(
    req: GapValidateRequest | None = None,
    user: UserInfo = Depends(require_admin),
):
    """Re-query RAG for open knowledge gaps and auto-resolve satisfied ones.

    For each open/reopened gap, runs a vector similarity search against
    synesis_catalog using the gap's embedding. If the top hit score exceeds
    the threshold, the gap is auto-resolved.

    Requires Milvus for vector search. If Milvus is unavailable, returns
    an error explaining that vector search is needed.
    """
    threshold = req.score_threshold if req else 0.6
    max_gaps = req.max_gaps if req else 200

    try:
        from ..deps import get_milvus
        from ..services.milvus_service import safe_query, safe_vector_search
    except ImportError:
        return GapValidateResponse(
            errors=1,
            details=[{"status": "error", "reason": "Milvus client not available; vector search required for validation."}],
        )

    # Get open gaps from Postgres
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

    # Fetch embeddings from Milvus knowledge_backlog
    client = get_milvus()
    if "synesis_knowledge_backlog" not in client.list_collections():
        return GapValidateResponse(
            errors=1,
            details=[{"status": "error", "reason": "synesis_knowledge_backlog collection not found; vector search required for validation."}],
        )

    validated = 0
    still_open = 0
    errors = 0
    details: list[dict] = []

    for gap in open_gaps:
        chunk_id = gap.gap_id
        query = gap.query or ""

        try:
            milvus_results = safe_query(
                "synesis_knowledge_backlog",
                filter_expr=f'chunk_id == "{chunk_id[:64]}"',
                output_fields=["chunk_id", "query", "embedding", "max_score", "timestamp"],
                limit=1,
            )
        except Exception as exc:
            errors += 1
            details.append({"chunk_id": chunk_id, "status": "error", "reason": str(exc)[:120]})
            continue

        if not milvus_results:
            errors += 1
            details.append({"chunk_id": chunk_id, "status": "error", "reason": "gap not found in Milvus backlog"})
            continue

        embedding = milvus_results[0].get("embedding")
        if not embedding or not isinstance(embedding, list) or len(embedding) < 10:
            errors += 1
            details.append({"chunk_id": chunk_id, "status": "error", "reason": "missing_embedding"})
            continue

        try:
            hits = safe_vector_search(
                "synesis_catalog",
                vector=embedding,
                top_k=1,
                output_fields=["chunk_id", "text", "source_url"],
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
