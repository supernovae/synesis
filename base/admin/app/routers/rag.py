"""RAG pipeline: corpus stats, quality, benchmarks."""

from __future__ import annotations

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
    try:
        scorecards.sort(key=lambda s: s.get(sort, ""))
    except Exception:
        pass
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
