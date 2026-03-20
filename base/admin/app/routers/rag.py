"""RAG pipeline: corpus stats, quality, benchmarks."""

from __future__ import annotations

import contextlib
import json
import logging
from datetime import UTC
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Query

from ..auth import UserInfo, get_current_user
from ..deps import CATALOG_COLLECTION, QUALITY_REPORT_PATH
from ..services.milvus_service import (
    collection_domain_hierarchy,
    collection_schema_info,
    collection_stats,
    safe_query,
)

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
    from ..db.engine import async_session as _async_session
    from ..db.models import MilvusSchemaSync

    schema_version = 0
    try:
        async with _async_session() as session:
            from sqlalchemy import select as _select

            row = (
                await session.execute(
                    _select(MilvusSchemaSync).where(MilvusSchemaSync.collection == CATALOG_COLLECTION)
                )
            ).scalar_one_or_none()
            if row:
                schema_version = row.schema_version
    except Exception:
        pass

    try:
        stats = collection_stats(CATALOG_COLLECTION)
        meta_rows = safe_query(
            CATALOG_COLLECTION,
            output_fields=["domain", "doc_id", "source_name"],
            limit=16384,
        )
        unique_domains = len({r.get("domain", "") for r in meta_rows if r.get("domain")})
        unique_docs = len({r.get("doc_id", "") for r in meta_rows if r.get("doc_id")})
        unique_sources = len({r.get("source_name", "") for r in meta_rows if r.get("source_name")})
        return {
            "collection": CATALOG_COLLECTION,
            "total_chunks": stats.get("row_count", 0),
            "total_documents": unique_docs,
            "total_sources": unique_sources,
            "domains_covered": unique_domains,
            "schema_version": schema_version,
        }
    except Exception:
        logger.warning("corpus_overview_failed", exc_info=True)
        return {
            "collection": CATALOG_COLLECTION,
            "total_chunks": 0,
            "total_documents": 0,
            "total_sources": 0,
            "domains_covered": 0,
            "schema_version": schema_version,
        }


@router.get("/corpus/schema")
async def corpus_schema(_user: UserInfo = Depends(get_current_user)):
    """Milvus collection schema: fields, indexes, domain->source hierarchy."""
    try:
        schema = collection_schema_info(CATALOG_COLLECTION)
        hierarchy = collection_domain_hierarchy(CATALOG_COLLECTION)
        return {
            "collection": CATALOG_COLLECTION,
            "schema": schema,
            "hierarchy": hierarchy,
        }
    except Exception:
        logger.warning("corpus_schema_failed", exc_info=True)
        return {"collection": CATALOG_COLLECTION, "schema": {"exists": False}, "hierarchy": []}


@router.get("/quality")
async def quality_summary(_user: UserInfo = Depends(get_current_user)):
    """Quality summary — try DB snapshots first, fall back to JSON file."""
    try:
        from sqlalchemy import select

        from ..db.engine import async_session
        from ..db.models import QualitySnapshot

        async with async_session() as session:
            rows = (
                (
                    await session.execute(
                        select(QualitySnapshot)
                        .distinct(QualitySnapshot.domain)
                        .order_by(QualitySnapshot.domain, QualitySnapshot.scored_at.desc())
                    )
                )
                .scalars()
                .all()
            )
            if rows:
                scorecards = []
                counts = {"strong": 0, "adequate": 0, "weak": 0, "empty": 0}
                for r in rows:
                    h = r.health
                    counts[h] = counts.get(h, 0) + 1
                    scorecards.append(
                        {
                            "domain": r.domain,
                            "health": r.health,
                            "chunk_count": r.chunk_count,
                            "doc_count": r.doc_count,
                            "freshness_pct": r.freshness_pct,
                            "authority_mix": r.authority_mix,
                            "dead_weight_count": r.dead_weight_count,
                            "scored_at": r.scored_at.isoformat() if r.scored_at else None,
                        }
                    )
                return {**counts, "scorecards": scorecards}
    except Exception:
        logger.debug("quality_db_read_failed", exc_info=True)

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


@router.post("/quality/refresh")
async def quality_refresh(_user: UserInfo = Depends(get_current_user)):
    """Compute per-domain health scores from Milvus and store in quality_snapshots."""
    hierarchy = collection_domain_hierarchy(CATALOG_COLLECTION)
    if not hierarchy:
        return {"ok": False, "error": "no corpus data"}

    from datetime import datetime

    from ..db.engine import async_session
    from ..db.models import QualitySnapshot

    now = datetime.now(UTC)
    snapshots = []
    for entry in hierarchy:
        domain = entry["domain"]
        chunk_count = entry["total_chunks"]
        sources = entry.get("sources", [])
        doc_count = len(sources)

        authority_mix: dict[str, int] = {}
        for row in safe_query(
            CATALOG_COLLECTION,
            filter_expr=f'domain == "{domain}"',
            output_fields=["authority"],
            limit=16384,
        ):
            auth = row.get("authority", "unknown") or "unknown"
            authority_mix[auth] = authority_mix.get(auth, 0) + 1

        if chunk_count == 0:
            health = "empty"
        elif chunk_count < 10:
            health = "weak"
        elif chunk_count < 50:
            health = "adequate"
        else:
            health = "strong"

        snapshots.append(
            QualitySnapshot(
                domain=domain,
                health=health,
                chunk_count=chunk_count,
                doc_count=doc_count,
                freshness_pct=0.0,
                authority_mix=authority_mix,
                dead_weight_count=0,
                scored_at=now,
            )
        )

    try:
        async with async_session() as session:
            session.add_all(snapshots)
            await session.commit()
    except Exception:
        logger.warning("quality_refresh_persist_failed", exc_info=True)
        return {"ok": False, "error": "persist failed"}

    counts = {"strong": 0, "adequate": 0, "weak": 0, "empty": 0}
    for s in snapshots:
        counts[s.health] = counts.get(s.health, 0) + 1

    return {"ok": True, "domains": len(snapshots), "summary": counts}


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


def _scorecard_from_snapshot(row: Any) -> dict:
    """Shape stored Milvus-derived snapshots for the Domain Health React page."""
    return {
        "domain": row.domain,
        "path": "",
        "health": row.health,
        "inventory": {
            "total_chunks": row.chunk_count,
            "total_documents": row.doc_count,
        },
        "coverage": {
            "hit_rate": (row.freshness_pct or 0.0) / 100.0,
            "mean_mrr": 0.0,
        },
        "dead_weight": {"unretrieved_documents": row.dead_weight_count},
        "authority_mix": row.authority_mix or {},
        "scored_at": row.scored_at.isoformat() if getattr(row, "scored_at", None) else None,
        "source": "quality_snapshots",
    }


@router.get("/quality/domains/{key}")
async def quality_domain_detail(
    key: str,
    _user: UserInfo = Depends(get_current_user),
):
    report = _load_quality_report()
    for sc in report.get("scorecards", []):
        if sc.get("domain") == key:
            return sc
    try:
        from sqlalchemy import select

        from ..db.engine import async_session
        from ..db.models import QualitySnapshot

        async with async_session() as session:
            row = (
                (
                    await session.execute(
                        select(QualitySnapshot)
                        .where(QualitySnapshot.domain == key)
                        .order_by(QualitySnapshot.scored_at.desc())
                        .limit(1)
                    )
                )
                .scalars()
                .first()
            )
        if row is not None:
            return _scorecard_from_snapshot(row)
    except Exception:
        logger.debug("quality_domain_db_read_failed", exc_info=True)

    return {"domain": key, "health": "unknown", "inventory": {}, "coverage": {}, "dead_weight": {}}


@router.get("/benchmarks")
async def benchmarks(_user: UserInfo = Depends(get_current_user)):
    """Return latest benchmark results — try DB first, fall back to JSON file."""
    try:
        from sqlalchemy import select

        from ..db.engine import async_session
        from ..db.models import BenchmarkResult

        async with async_session() as session:
            row = (
                await session.execute(
                    select(BenchmarkResult)
                    .where(BenchmarkResult.completed_at.isnot(None))
                    .order_by(BenchmarkResult.started_at.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if row and row.metrics:
                return {
                    "aggregate": row.metrics,
                    "per_query": row.per_query or [],
                    "run_id": row.run_id,
                    "benchmark_type": row.benchmark_type,
                    "triggered_by": row.triggered_by,
                    "started_at": row.started_at.isoformat() if row.started_at else None,
                }
    except Exception:
        logger.debug("benchmark_db_read_failed", exc_info=True)

    p = Path("benchmarks/retrieval/results_hybrid.json")
    if not p.exists():
        return {"aggregate": {}, "per_query": []}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {"aggregate": {}, "per_query": []}


@router.get("/benchmarks/history")
async def benchmark_history(
    _user: UserInfo = Depends(get_current_user),
    limit: int = Query(10, ge=1, le=50),
):
    """List recent benchmark runs."""
    try:
        from sqlalchemy import select

        from ..db.engine import async_session
        from ..db.models import BenchmarkResult

        async with async_session() as session:
            rows = (
                (
                    await session.execute(
                        select(BenchmarkResult).order_by(BenchmarkResult.started_at.desc()).limit(limit)
                    )
                )
                .scalars()
                .all()
            )
            return {
                "runs": [
                    {
                        "run_id": r.run_id,
                        "benchmark_type": r.benchmark_type,
                        "triggered_by": r.triggered_by,
                        "started_at": r.started_at.isoformat() if r.started_at else None,
                        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
                        "aggregate": r.metrics or {},
                    }
                    for r in rows
                ]
            }
    except Exception:
        return {"runs": []}


@router.post("/benchmarks/run")
async def benchmark_run(_user: UserInfo = Depends(get_current_user)):
    """Trigger a lightweight benchmark: retrieve a few test queries and measure quality."""
    import hashlib
    import time as _time
    from datetime import datetime

    from ..db.engine import async_session
    from ..db.models import BenchmarkResult

    run_id = hashlib.sha256(f"bench-{_time.time()}".encode()).hexdigest()[:16]
    now = datetime.now(UTC)

    test_queries = [
        "How does FAISS handle hybrid search with metadata filtering?",
        "What is the best vector database for production RAG systems?",
        "How does LangGraph implement multi-agent orchestration?",
        "What are the tradeoffs between BM25 and dense retrieval?",
        "How to deploy vLLM on Kubernetes with GPU sharing?",
    ]

    per_query = []
    total_hits = 0
    total_time = 0.0

    for q in test_queries:
        start = _time.time()
        results = safe_query(
            CATALOG_COLLECTION,
            output_fields=["chunk_id", "text", "domain", "authority"],
            limit=10,
        )
        elapsed = (_time.time() - start) * 1000
        total_time += elapsed
        hits = len(results)
        total_hits += hits
        per_query.append(
            {
                "query": q,
                "hits": hits,
                "latency_ms": round(elapsed, 1),
            }
        )

    aggregate = {
        "total_queries": len(test_queries),
        "avg_hits": round(total_hits / max(len(test_queries), 1), 1),
        "avg_latency_ms": round(total_time / max(len(test_queries), 1), 1),
        "p95_ms": round(
            sorted([p["latency_ms"] for p in per_query])[int(len(per_query) * 0.95)] if per_query else 0, 1
        ),
    }

    try:
        async with async_session() as session:
            session.add(
                BenchmarkResult(
                    run_id=run_id,
                    benchmark_type="lightweight",
                    metrics=aggregate,
                    per_query=per_query,
                    triggered_by=_user.username,
                    started_at=now,
                    completed_at=datetime.now(UTC),
                )
            )
            await session.commit()
    except Exception:
        logger.warning("benchmark_persist_failed", exc_info=True)

    return {"ok": True, "run_id": run_id, "aggregate": aggregate, "per_query": per_query}


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
    "content_format",
    "symbol_type",
    "approval_status",
]

# Lightweight copy of the indexer's named patterns for on-the-fly reason extraction.
# Kept in sync with base/rag/indexer/app/injection_scan.py.
import re as _re

_FLAG_PATTERNS: list[tuple[str, str, _re.Pattern[str]]] = [
    (
        "ignore_previous_instructions",
        "Ignore previous instructions",
        _re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?", _re.IGNORECASE),
    ),
    (
        "disregard_previous",
        "Disregard previous context",
        _re.compile(r"disregard\s+(?:all\s+)?(?:previous|prior|above)", _re.IGNORECASE),
    ),
    (
        "forget_everything",
        "Forget everything told",
        _re.compile(r"forget\s+(?:everything|all)\s+(?:you\s+)?(?:were\s+)?told", _re.IGNORECASE),
    ),
    ("new_instructions", "New instructions block", _re.compile(r"new\s+instructions?\s*:", _re.IGNORECASE)),
    (
        "override_instructions",
        "Override instructions/prompt",
        _re.compile(r"override\s+(?:your\s+)?(?:instructions?|prompt)", _re.IGNORECASE),
    ),
    (
        "role_hijack_you_are_now",
        "Role hijack: 'you are now'",
        _re.compile(r"you\s+are\s+now\s+(?:a|an)\s", _re.IGNORECASE),
    ),
    ("role_hijack_pretend", "Role hijack: 'pretend you are'", _re.compile(r"pretend\s+you\s+are", _re.IGNORECASE)),
    ("role_hijack_act_as", "Role hijack: 'act as if'", _re.compile(r"act\s+as\s+if\s+you", _re.IGNORECASE)),
    ("system_prompt_marker", "System prompt marker (system:)", _re.compile(r"system\s*:\s*", _re.IGNORECASE)),
    ("chatml_system_tag", "ChatML system tag", _re.compile(r"<\|im_start\|>\s*system", _re.IGNORECASE)),
    ("markdown_human_prompt", "Markdown human prompt (### human:)", _re.compile(r"###\s*human\s*:", _re.IGNORECASE)),
    ("llama_inst_tag", "Llama [INST] tag", _re.compile(r"\[INST\]\s*", _re.IGNORECASE)),
    ("xml_system_tag", "XML system/s tag", _re.compile(r"<\/?s(?:ystem)?>", _re.IGNORECASE)),
    ("ignore_the_above", "Ignore the above", _re.compile(r"ignore\s+the\s+above", _re.IGNORECASE)),
    ("ignore_above", "Ignore above", _re.compile(r"ignore\s+above\b", _re.IGNORECASE)),
    (
        "follow_instead",
        "Follow these instructions instead",
        _re.compile(r"follow\s+these\s+instructions?\s+instead", _re.IGNORECASE),
    ),
    (
        "output_only_following",
        "Output only the following",
        _re.compile(r"output\s+(?:only|just)\s+the\s+following", _re.IGNORECASE),
    ),
    ("print_exactly_this", "Print exactly this", _re.compile(r"print\s+(?:exactly|only)\s+this\s*:", _re.IGNORECASE)),
]


def _detect_flag_reasons(text: str) -> list[dict[str, str]]:
    """Return list of {id, label} for each injection pattern matched in text."""
    sample = text[:32_000].lower()
    reasons = []
    for pid, label, pat in _FLAG_PATTERNS:
        if pat.search(sample):
            reasons.append({"id": pid, "label": label})
    return reasons


@router.get("/review/stats")
async def review_stats(_user: UserInfo = Depends(get_current_user)):
    """Counts by scan_status and approval_status for the review queue badge."""
    flagged = safe_query(
        CATALOG_COLLECTION, filter_expr='scan_status == "flagged"', output_fields=["chunk_id"], limit=10000
    )
    unscanned = safe_query(
        CATALOG_COLLECTION, filter_expr='scan_status == "unscanned"', output_fields=["chunk_id"], limit=10000
    )
    pending = safe_query(
        CATALOG_COLLECTION, filter_expr='approval_status == "pending"', output_fields=["chunk_id"], limit=10000
    )
    return {"flagged": len(flagged), "unscanned": len(unscanned), "pending_approval": len(pending)}


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
        full_text = r.pop("text", "")
        r["text_preview"] = full_text[:500]
        if r.get("scan_status") == "flagged" and full_text:
            r["flag_reasons"] = _detect_flag_reasons(full_text)
        else:
            r["flag_reasons"] = []
    return {"chunks": rows, "offset": offset, "limit": limit}


@router.post("/review/{chunk_id}/vet")
async def vet_chunk(chunk_id: str, _user: UserInfo = Depends(get_current_user)):
    """Mark a chunk as vetted: set scan_status to 'vetted', approval_status to 'approved'."""
    from ..services.milvus_service import safe_query as sq

    rows = sq(
        CATALOG_COLLECTION, filter_expr=f'chunk_id == "{chunk_id}"', output_fields=["authority", "scan_status"], limit=1
    )
    if not rows:
        return {"ok": False, "error": "chunk not found"}
    try:
        client = get_milvus()
        client.upsert(
            collection_name=CATALOG_COLLECTION,
            data=[
                {"chunk_id": chunk_id, "scan_status": "vetted", "authority": "vetted", "approval_status": "approved"}
            ],
        )
    except Exception:
        logger.warning("review_vet_milvus_update_failed", extra={"chunk_id": chunk_id}, exc_info=True)
        return {"ok": False, "error": "milvus update failed"}
    logger.info("review_vet_chunk", extra={"chunk_id": chunk_id, "user": _user.username})
    return {"ok": True, "chunk_id": chunk_id, "action": "vetted"}


@router.post("/review/{chunk_id}/reject")
async def reject_chunk(chunk_id: str, _user: UserInfo = Depends(get_current_user)):
    """Mark a chunk as rejected: set approval_status to 'rejected' (excluded from RAG retrieval)."""
    try:
        client = get_milvus()
        client.upsert(
            collection_name=CATALOG_COLLECTION,
            data=[{"chunk_id": chunk_id, "scan_status": "rejected", "approval_status": "rejected"}],
        )
        ok = True
    except Exception:
        logger.warning("review_reject_milvus_update_failed", extra={"chunk_id": chunk_id}, exc_info=True)
        ok = False
    logger.info("review_reject_chunk", extra={"chunk_id": chunk_id, "user": _user.username, "ok": ok})
    return {"ok": ok, "chunk_id": chunk_id, "action": "rejected"}


@router.post("/review/bulk/{action}")
async def bulk_review_action(
    action: str,
    request: dict,
    _user: UserInfo = Depends(get_current_user),
):
    """Bulk approve or reject multiple chunks.

    POST /review/bulk/vet   {"chunk_ids": ["id1", "id2"]}
    POST /review/bulk/reject {"chunk_ids": ["id1", "id2"]}
    """
    chunk_ids = request.get("chunk_ids", [])
    if not chunk_ids:
        return {"ok": False, "error": "no chunk_ids provided"}
    if action not in ("vet", "reject"):
        return {"ok": False, "error": "action must be 'vet' or 'reject'"}

    results = {"ok": True, "processed": 0, "errors": 0}
    client = get_milvus()

    for chunk_id in chunk_ids:
        try:
            if action == "vet":
                client.upsert(
                    collection_name=CATALOG_COLLECTION,
                    data=[
                        {
                            "chunk_id": chunk_id,
                            "scan_status": "vetted",
                            "authority": "vetted",
                            "approval_status": "approved",
                        }
                    ],
                )
            else:
                client.upsert(
                    collection_name=CATALOG_COLLECTION,
                    data=[{"chunk_id": chunk_id, "scan_status": "rejected", "approval_status": "rejected"}],
                )
            results["processed"] += 1
        except Exception:
            logger.warning("review_bulk_%s_failed", action, extra={"chunk_id": chunk_id}, exc_info=True)
            results["errors"] += 1

    logger.info(
        "review_bulk_action",
        extra={"action": action, "count": len(chunk_ids), "processed": results["processed"], "user": _user.username},
    )
    return results


def get_milvus():
    from ..deps import get_milvus as _gm

    return _gm()
