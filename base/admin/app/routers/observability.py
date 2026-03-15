"""Observability: health, cache, circuit breakers, failures, knowledge gaps."""

import logging
import time

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from ..auth import UserInfo, get_current_user, require_admin
from ..deps import FAILURES_COLLECTION, KNOWLEDGE_BACKLOG_COLLECTION
from ..services import prometheus_client_svc as prom
from ..services.health_prober import probe_all
from ..services.milvus_service import safe_delete, safe_query, safe_upsert

logger = logging.getLogger("synesis.admin.observability")

KNOWLEDGE_GAP_STATUS_COLLECTION = "synesis_knowledge_gap_status"

router = APIRouter(prefix="/api/v1/observability", tags=["observability"])


@router.get("/health")
async def service_health(_user: UserInfo = Depends(get_current_user)):
    services = await probe_all()
    return {"services": services}


@router.get("/cache")
async def cache_metrics(_user: UserInfo = Depends(get_current_user)):
    return await prom.get_cache_metrics()


@router.get("/circuit-breakers")
async def circuit_breakers(_user: UserInfo = Depends(get_current_user)):
    breakers = await prom.get_circuit_breaker_metrics()
    return {"breakers": breakers}


@router.get("/failures")
async def failure_list(
    _user: UserInfo = Depends(get_current_user),
    language: str = Query("", description="Filter by language"),
    error_type: str = Query("", description="Filter by error type"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    parts = []
    if language:
        parts.append(f'language == "{language}"')
    if error_type:
        parts.append(f'error_type == "{error_type}"')
    filter_expr = " and ".join(parts)
    offset = (page - 1) * page_size
    failures = safe_query(
        FAILURES_COLLECTION,
        filter_expr=filter_expr,
        output_fields=[
            "failure_id",
            "code",
            "error_output",
            "exit_code",
            "error_type",
            "language",
            "task_description",
            "resolution",
            "timestamp",
        ],
        limit=page_size,
        offset=offset,
    )
    return {"failures": failures, "total": len(failures)}


@router.get("/failures/stats")
async def failure_stats(_user: UserInfo = Depends(get_current_user)):
    all_failures = safe_query(
        FAILURES_COLLECTION,
        output_fields=["error_type", "language", "resolution"],
        limit=10000,
    )
    total = len(all_failures)
    by_language: dict[str, int] = {}
    by_error_type: dict[str, int] = {}
    resolved = 0
    for f in all_failures:
        lang = f.get("language", "unknown")
        etype = f.get("error_type", "unknown")
        by_language[lang] = by_language.get(lang, 0) + 1
        by_error_type[etype] = by_error_type.get(etype, 0) + 1
        if f.get("resolution"):
            resolved += 1
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
    results = safe_query(
        FAILURES_COLLECTION,
        filter_expr=f'failure_id == "{failure_id}"',
        output_fields=[
            "failure_id",
            "code",
            "error_output",
            "exit_code",
            "error_type",
            "language",
            "task_description",
            "resolution",
            "timestamp",
        ],
        limit=1,
    )
    if results:
        return results[0]
    return {"error": "not found"}


# ── Knowledge Gaps (retrieval degradation feedback loop) ──


@router.get("/knowledge-gaps")
async def knowledge_gaps(
    _user: UserInfo = Depends(get_current_user),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query("", description="Filter by status: open, resolved, reopened"),
):
    """List queries where RAG confidence was below threshold, signaling corpus gaps."""
    offset = (page - 1) * page_size
    gaps = safe_query(
        KNOWLEDGE_BACKLOG_COLLECTION,
        output_fields=[
            "chunk_id",
            "query",
            "task_description",
            "collections_queried",
            "max_score",
            "platform_context",
            "timestamp",
            "language",
        ],
        limit=page_size,
        offset=offset,
    )

    # Enrich with lifecycle status
    chunk_ids = [g.get("chunk_id", "") for g in gaps if g.get("chunk_id")]
    statuses = _batch_gap_statuses(chunk_ids)
    for g in gaps:
        cid = g.get("chunk_id", "")
        st = statuses.get(cid, {})
        g["status"] = st.get("status", "open")
        g["resolved_at"] = st.get("resolved_at", 0)
        g["resolved_by"] = st.get("resolved_by", "")
        g["resolution_note"] = st.get("resolution_note", "")

    # Filter by status if requested
    if status:
        gaps = [g for g in gaps if g.get("status") == status]

    return {"gaps": gaps, "total": len(gaps)}


@router.get("/knowledge-gaps/stats")
async def knowledge_gap_stats(_user: UserInfo = Depends(get_current_user)):
    """Aggregate stats on RAG corpus gaps for prioritization."""
    all_gaps = safe_query(
        KNOWLEDGE_BACKLOG_COLLECTION,
        output_fields=["chunk_id", "max_score", "platform_context", "language", "timestamp"],
        limit=10000,
    )
    total = len(all_gaps)
    if not total:
        return {"total_gaps": 0, "avg_score": 0, "by_context": {}, "by_language": {}, "by_status": {}}

    chunk_ids = [g.get("chunk_id", "") for g in all_gaps if g.get("chunk_id")]
    statuses = _batch_gap_statuses(chunk_ids)

    avg_score = sum(g.get("max_score", 0) for g in all_gaps) / total
    by_context: dict[str, int] = {}
    by_language: dict[str, int] = {}
    by_status: dict[str, int] = {"open": 0, "resolved": 0, "reopened": 0}
    for g in all_gaps:
        ctx = g.get("platform_context", "unknown")
        lang = g.get("language", "unknown")
        by_context[ctx] = by_context.get(ctx, 0) + 1
        by_language[lang] = by_language.get(lang, 0) + 1
        st = statuses.get(g.get("chunk_id", ""), {}).get("status", "open")
        by_status[st] = by_status.get(st, 0) + 1

    return {
        "total_gaps": total,
        "avg_score": round(avg_score, 4),
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
    ok = safe_upsert(
        KNOWLEDGE_GAP_STATUS_COLLECTION,
        {
            "chunk_id": chunk_id[:64],
            "status": "resolved",
            "resolved_at": int(time.time()),
            "resolved_by": user.username,
            "resolution_note": note[:1024],
            "updated_at": int(time.time()),
        },
    )
    if ok:
        return {"status": "resolved", "chunk_id": chunk_id}
    return {"error": "failed to update status"}


@router.post("/knowledge-gaps/{chunk_id}/reopen")
async def reopen_gap(
    chunk_id: str,
    user: UserInfo = Depends(require_admin),
):
    """Reopen a previously resolved knowledge gap."""
    ok = safe_upsert(
        KNOWLEDGE_GAP_STATUS_COLLECTION,
        {
            "chunk_id": chunk_id[:64],
            "status": "reopened",
            "resolved_at": 0,
            "resolved_by": "",
            "resolution_note": "",
            "updated_at": int(time.time()),
        },
    )
    if ok:
        return {"status": "reopened", "chunk_id": chunk_id}
    return {"error": "failed to update status"}


@router.delete("/knowledge-gaps/{chunk_id}")
async def purge_gap(
    chunk_id: str,
    _user: UserInfo = Depends(require_admin),
):
    """Permanently delete a knowledge gap and its status record."""
    safe_delete(KNOWLEDGE_BACKLOG_COLLECTION, chunk_id)
    safe_delete(KNOWLEDGE_GAP_STATUS_COLLECTION, chunk_id)
    return {"status": "purged", "chunk_id": chunk_id}


def _batch_gap_statuses(chunk_ids: list[str]) -> dict[str, dict]:
    """Batch-fetch gap lifecycle statuses."""
    if not chunk_ids:
        return {}
    id_list = ",".join(f'"{cid[:64]}"' for cid in chunk_ids[:200])
    results = safe_query(
        KNOWLEDGE_GAP_STATUS_COLLECTION,
        filter_expr=f"chunk_id in [{id_list}]",
        output_fields=["chunk_id", "status", "resolved_at", "resolved_by", "resolution_note", "updated_at"],
        limit=200,
    )
    return {r["chunk_id"]: r for r in results}
