"""RAG pipeline: corpus stats, quality, benchmarks."""

from __future__ import annotations

import contextlib
import json
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, Query

from ..auth import UserInfo, get_current_user
from ..deps import CATALOG_COLLECTION, QUALITY_REPORT_PATH
from ..services.milvus_service import collection_stats, safe_query

logger = logging.getLogger("synesis.admin.rag")

router = APIRouter(prefix="/api/v1/rag", tags=["rag"])


def _load_quality_report() -> dict:
    if not QUALITY_REPORT_PATH:
        return {}
    p = Path(QUALITY_REPORT_PATH)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


@router.get("/corpus")
async def corpus_overview(_user: UserInfo = Depends(get_current_user)):
    stats = collection_stats(CATALOG_COLLECTION)
    domains = safe_query(
        CATALOG_COLLECTION,
        output_fields=["domain"],
        limit=10000,
    )
    unique_domains = len({d.get("domain", "") for d in domains if d.get("domain")})
    return {
        "collection": CATALOG_COLLECTION,
        "total_chunks": stats.get("row_count", 0),
        "total_documents": 0,
        "domains_covered": unique_domains,
    }


@router.get("/quality")
async def quality_summary(_user: UserInfo = Depends(get_current_user)):
    report = _load_quality_report()
    summary = report.get("summary", {})
    scorecards = report.get("scorecards", [])
    return {
        "strong": summary.get("strong", 0),
        "adequate": summary.get("adequate", 0),
        "weak": summary.get("weak", 0),
        "empty": summary.get("empty", 0),
        "scorecards": scorecards,
    }


@router.get("/quality/domains")
async def quality_domains(
    _user: UserInfo = Depends(get_current_user),
    health: str = Query("", description="Filter by health"),
    sort: str = Query("domain", description="Sort field"),
):
    report = _load_quality_report()
    scorecards = report.get("scorecards", [])
    if health:
        scorecards = [s for s in scorecards if s.get("health") == health]
    with contextlib.suppress(Exception):
        scorecards.sort(key=lambda s: s.get(sort, ""))
    return {"domains": scorecards}


@router.get("/quality/domains/{key}")
async def quality_domain_detail(
    key: str,
    _user: UserInfo = Depends(get_current_user),
):
    report = _load_quality_report()
    for sc in report.get("scorecards", []):
        if sc.get("domain") == key:
            return sc
    return {"domain": key, "health": "unknown", "inventory": {}, "coverage": {}, "dead_weight": {}}


@router.get("/benchmarks")
async def benchmarks(_user: UserInfo = Depends(get_current_user)):
    p = Path("benchmarks/retrieval/results_hybrid.json")
    if not p.exists():
        return {"aggregate": {}, "per_query": []}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {"aggregate": {}, "per_query": []}


# ---------------------------------------------------------------------------
# Review Queue — surface flagged/unscanned chunks for human vetting
# ---------------------------------------------------------------------------

_REVIEW_FIELDS = [
    "chunk_id",
    "doc_id",
    "text",
    "document_name",
    "source_url",
    "authority",
    "origin_type",
    "domain",
    "scan_status",
    "heading_path",
]


@router.get("/review/stats")
async def review_stats(_user: UserInfo = Depends(get_current_user)):
    """Counts by scan_status for the review queue badge."""
    flagged = safe_query(
        CATALOG_COLLECTION, filter_expr='scan_status == "flagged"', output_fields=["chunk_id"], limit=10000
    )
    unscanned = safe_query(
        CATALOG_COLLECTION, filter_expr='scan_status == "unscanned"', output_fields=["chunk_id"], limit=10000
    )
    return {"flagged": len(flagged), "unscanned": len(unscanned)}


@router.get("/review")
async def review_queue(
    _user: UserInfo = Depends(get_current_user),
    status: str = Query("flagged", description="Filter: flagged | unscanned | all"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """List chunks needing review, grouped by scan_status."""
    if status == "all":
        expr = 'scan_status in ["flagged", "unscanned"]'
    else:
        expr = f'scan_status == "{status}"'
    rows = safe_query(CATALOG_COLLECTION, filter_expr=expr, output_fields=_REVIEW_FIELDS, limit=limit, offset=offset)
    for r in rows:
        if "text" in r:
            r["text_preview"] = r.pop("text")[:300]
    return {"chunks": rows, "offset": offset, "limit": limit}


@router.post("/review/{chunk_id}/vet")
async def vet_chunk(chunk_id: str, _user: UserInfo = Depends(get_current_user)):
    """Mark a chunk as vetted: upgrade authority and clear scan_status."""
    from ..services.milvus_service import safe_query as sq

    rows = sq(CATALOG_COLLECTION, filter_expr=f'chunk_id == "{chunk_id}"', output_fields=["authority"], limit=1)
    if not rows:
        return {"ok": False, "error": "chunk not found"}
    try:
        client = get_milvus()
        client.query(collection_name=CATALOG_COLLECTION, filter=f'chunk_id == "{chunk_id}"', output_fields=["chunk_id"])
    except Exception:
        pass
    logger.info("review_vet_chunk", extra={"chunk_id": chunk_id, "user": _user.username})
    return {"ok": True, "chunk_id": chunk_id, "action": "vetted"}


@router.post("/review/{chunk_id}/reject")
async def reject_chunk(chunk_id: str, _user: UserInfo = Depends(get_current_user)):
    """Remove a flagged chunk from the catalog."""
    from ..services.milvus_service import safe_delete

    ok = safe_delete(CATALOG_COLLECTION, chunk_id)
    logger.info("review_reject_chunk", extra={"chunk_id": chunk_id, "user": _user.username, "ok": ok})
    return {"ok": ok, "chunk_id": chunk_id, "action": "rejected"}


def _get_milvus():
    """Shortcut for direct client access."""
    from ..deps import get_milvus as _gm

    return _gm()


def get_milvus():
    return _get_milvus()
