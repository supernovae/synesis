"""RAG pipeline: corpus stats, quality, benchmarks."""

from __future__ import annotations

import contextlib
import json
import logging
from datetime import UTC
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func

from ..auth import UserInfo, get_current_user
from ..deps import CATALOG_COLLECTION, QUALITY_REPORT_PATH
from ..rbac import RouteGroup, can_access_route_group
from ..services.nornic_service import (
    collection_domain_hierarchy,
    collection_schema_info,
    collection_stats,
    expected_graph_schema_version,
    safe_query,
)

logger = logging.getLogger("synesis.admin.rag")

router = APIRouter(prefix="/api/v1/rag", tags=["rag"])


def _ensure_org_observability(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_observability):
        raise HTTPException(status_code=403, detail="Requires route group access: org_observability")


def _ensure_org_content_admin(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_content_admin):
        raise HTTPException(status_code=403, detail="Requires route group access: org_content_admin")


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


def _drop_error_fields(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _drop_error_fields(v) for k, v in value.items() if k != "error"}
    if isinstance(value, list):
        return [_drop_error_fields(v) for v in value]
    return value


def _sanitize_schema_info(schema: Any) -> dict[str, Any]:
    if not isinstance(schema, dict):
        return {"exists": False, "fields": [], "indexes": []}
    exists = bool(schema.get("exists", False))
    fields = schema.get("fields")
    indexes = schema.get("indexes")
    return {
        "exists": exists,
        "fields": fields if isinstance(fields, list) else [],
        "indexes": indexes if isinstance(indexes, list) else [],
    }


@router.get("/corpus")
async def corpus_overview(_user: UserInfo = Depends(get_current_user)):
    _ensure_org_observability(_user)
    from ..db.engine import async_session as _async_session
    from ..db.models import GraphSchemaSync

    schema_version = 0
    try:
        async with _async_session() as session:
            from sqlalchemy import select as _select

            row = (
                await session.execute(
                    _select(GraphSchemaSync).where(GraphSchemaSync.collection == CATALOG_COLLECTION)
                )
            ).scalar_one_or_none()
            if row:
                schema_version = row.schema_version
    except Exception:
        pass

    expected_sv = expected_graph_schema_version()
    schema_upgrade_pending = schema_version < expected_sv

    try:
        stats = collection_stats(CATALOG_COLLECTION)
        meta_rows = safe_query(
            CATALOG_COLLECTION,
            output_fields=["domain", "doc_id", "document_name"],
            limit=16384,
        )
        unique_domains = len({r.get("domain", "") for r in meta_rows if r.get("domain")})
        unique_docs = len({r.get("doc_id", "") for r in meta_rows if r.get("doc_id")})
        unique_sources = len({r.get("document_name", "") for r in meta_rows if r.get("document_name")})
        return {
            "collection": CATALOG_COLLECTION,
            "total_chunks": int(stats.get("row_count", 0) or 0),
            "total_documents": unique_docs,
            "total_sources": unique_sources,
            "domains_covered": unique_domains,
            "schema_version": schema_version,
            "expected_schema_version": expected_sv,
            "schema_upgrade_pending": schema_upgrade_pending,
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
            "expected_schema_version": expected_sv,
            "schema_upgrade_pending": schema_upgrade_pending,
        }


@router.get("/corpus/schema")
async def corpus_schema(_user: UserInfo = Depends(get_current_user)):
    """Content graph collection schema: fields, indexes, domain->source hierarchy."""
    _ensure_org_observability(_user)
    try:
        schema = collection_schema_info(CATALOG_COLLECTION)
        hierarchy = collection_domain_hierarchy(CATALOG_COLLECTION)
        return {
            "collection": CATALOG_COLLECTION,
            "schema": _sanitize_schema_info(schema),
            "hierarchy": _drop_error_fields(hierarchy),
        }
    except Exception:
        logger.warning("corpus_schema_failed", exc_info=True)
        return {"collection": CATALOG_COLLECTION, "schema": {"exists": False}, "hierarchy": []}


@router.get("/packs")
async def list_doc_packs(_user: UserInfo = Depends(get_current_user)):
    """List installed SynPack partitions from Content graph catalog metadata."""
    _ensure_org_observability(_user)
    rows = safe_query(
        CATALOG_COLLECTION,
        filter_expr='pack_id != ""',
        output_fields=[
            "pack_id",
            "pack_version",
            "pack_source_version",
            "language",
            "domain",
            "pack_artifact_hash",
        ],
        limit=16384,
    )
    packs: dict[str, dict[str, Any]] = {}
    for row in rows:
        pack_id = str(row.get("pack_id") or "global")
        entry = packs.setdefault(
            pack_id,
            {
                "pack_id": pack_id,
                "pack_version": row.get("pack_version", ""),
                "pack_source_version": row.get("pack_source_version", ""),
                "language": row.get("language", ""),
                "domain": row.get("domain", ""),
                "pack_artifact_hash": row.get("pack_artifact_hash", ""),
                "row_count": 0,
            },
        )
        entry["row_count"] += 1
    return {"packs": sorted(packs.values(), key=lambda item: str(item["pack_id"]))}


@router.get("/quality")
async def quality_summary(_user: UserInfo = Depends(get_current_user)):
    """Quality summary — try DB snapshots first, fall back to JSON file."""
    _ensure_org_observability(_user)
    try:
        from sqlalchemy import select
        from sqlalchemy.orm import aliased

        from ..db.engine import async_session
        from ..db.models import QualitySnapshot

        async with async_session() as session:
            # Window-based latest-per-domain: pick the newest scored_at per domain.
            sub = select(
                QualitySnapshot.id,
                func.row_number()
                .over(partition_by=QualitySnapshot.domain, order_by=QualitySnapshot.scored_at.desc())
                .label("rn"),
            ).subquery()
            qs = aliased(QualitySnapshot)
            rows = (
                (
                    await session.execute(
                        select(qs).join(sub, qs.id == sub.c.id).where(sub.c.rn == 1).order_by(qs.domain)
                    )
                )
                .scalars()
                .all()
            )
            if rows:
                scorecards = []
                counts: dict[str, int] = {"strong": 0, "adequate": 0, "weak": 0, "empty": 0}
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
                            "raw_scorecard": r.raw_scorecard if hasattr(r, "raw_scorecard") else None,
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
    """Compute per-domain health scores from Content graph and store in quality_snapshots."""
    _ensure_org_content_admin(_user)
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
        fresh_count = 0
        domain_rows = safe_query(
            CATALOG_COLLECTION,
            filter_expr=f'domain == "{domain}"',
            output_fields=["authority", "effective_at_epoch", "crawl_timestamp"],
            limit=16384,
        )
        for row in domain_rows:
            auth = row.get("authority", "unknown") or "unknown"
            authority_mix[auth] = authority_mix.get(auth, 0) + 1
            if _compute_freshness(row) >= 0.5:
                fresh_count += 1

        freshness_pct = round(fresh_count / max(len(domain_rows), 1) * 100, 1)

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
                freshness_pct=freshness_pct,
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


@router.post("/quality/import-report")
async def quality_import_report(
    body: dict,
    _user: UserInfo = Depends(get_current_user),
):
    """Import a corpus audit JSON report into ``quality_snapshots``.

    Accepts the same shape as ``corpus_audit_report.json``:
    ``{"summary": {...}, "scorecards": [...]}``.  Each scorecard is
    persisted as a ``QualitySnapshot`` row with the full scorecard
    stored in ``raw_scorecard`` so that domain-detail pages get
    MRR / hit-rate / dead-weight data without needing the JSON file.
    """
    _ensure_org_content_admin(_user)
    from datetime import datetime

    from ..db.engine import async_session
    from ..db.models import QualitySnapshot

    scorecards = body.get("scorecards", [])
    if not scorecards:
        return {"ok": False, "error": "no scorecards in payload"}

    now = datetime.now(UTC)
    snapshots = []
    for sc in scorecards:
        domain = sc.get("domain", "")
        if not domain:
            continue
        inv = sc.get("inventory", {})
        cov = sc.get("coverage", {})
        dw = sc.get("dead_weight", {})

        health = sc.get("health", "unknown")
        chunk_count = inv.get("total_chunks", 0)
        doc_count = inv.get("total_documents", 0)
        freshness_pct = round(float(cov.get("hit_rate", 0)) * 100, 2)
        dead_weight_count = dw.get("unretrieved_documents", 0)

        snapshots.append(
            QualitySnapshot(
                domain=domain,
                health=health,
                chunk_count=chunk_count,
                doc_count=doc_count,
                freshness_pct=freshness_pct,
                authority_mix=sc.get("authority_mix", {}),
                dead_weight_count=dead_weight_count,
                raw_scorecard=sc,
                scored_at=now,
            )
        )

    try:
        async with async_session() as session:
            session.add_all(snapshots)
            await session.commit()
    except Exception:
        logger.warning("quality_import_report_failed", exc_info=True)
        return {"ok": False, "error": "persist failed"}

    return {"ok": True, "imported": len(snapshots)}


@router.get("/quality/domains")
async def quality_domains(
    _user: UserInfo = Depends(get_current_user),
    health: str = Query("", description="Filter by health"),
    sort: str = Query("domain", description="Sort field"),
):
    _ensure_org_observability(_user)
    report = _load_quality_report()
    scorecards = report.get("scorecards", [])

    if not scorecards:
        try:
            from sqlalchemy import select
            from sqlalchemy.orm import aliased

            from ..db.engine import async_session
            from ..db.models import QualitySnapshot

            async with async_session() as session:
                sub = select(
                    QualitySnapshot.id,
                    func.row_number()
                    .over(
                        partition_by=QualitySnapshot.domain,
                        order_by=QualitySnapshot.scored_at.desc(),
                    )
                    .label("rn"),
                ).subquery()
                qs = aliased(QualitySnapshot)
                rows = (
                    (await session.execute(select(qs).join(sub, qs.id == sub.c.id).where(sub.c.rn == 1)))
                    .scalars()
                    .all()
                )
                scorecards = [_scorecard_from_snapshot(r) for r in rows]
        except Exception:
            logger.debug("quality_domains_db_fallback_failed", exc_info=True)

    if health:
        scorecards = [s for s in scorecards if s.get("health") == health]
    with contextlib.suppress(Exception):
        scorecards.sort(key=lambda s: s.get(sort, ""))
    return {"domains": scorecards}


def _scorecard_from_snapshot(row: Any) -> dict:
    """Shape stored Content graph-derived snapshots for the Domain Health React page.

    If the snapshot carries a ``raw_scorecard`` (imported audit JSON), we merge
    that data so the UI can surface MRR, hit-rate, and dead-weight samples even
    without the JSON file mounted.
    """
    base: dict[str, Any] = {
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
    raw = getattr(row, "raw_scorecard", None)
    if raw and isinstance(raw, dict):
        base["coverage"] = raw.get("coverage", base["coverage"])
        base["dead_weight"] = raw.get("dead_weight", base["dead_weight"])
        if raw.get("inventory"):
            base["inventory"] = raw["inventory"]
    return base


@router.get("/quality/domains/{key}")
async def quality_domain_detail(
    key: str,
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_observability(_user)
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
    _ensure_org_observability(_user)
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
    _ensure_org_observability(_user)
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


@router.post("/benchmarks/import")
async def benchmark_import(
    body: dict,
    _user: UserInfo = Depends(get_current_user),
):
    """Import a full regression benchmark result (e.g. from ``bench_hybrid.py``).

    Accepts ``{"run_id": "...", "aggregate": {...}, "per_query": [...]}``.
    """
    _ensure_org_content_admin(_user)
    import hashlib
    import time as _time
    from datetime import datetime

    from ..db.engine import async_session
    from ..db.models import BenchmarkResult

    run_id = body.get("run_id") or hashlib.sha256(f"bench-{_time.time()}".encode()).hexdigest()[:16]
    now = datetime.now(UTC)
    try:
        async with async_session() as session:
            session.add(
                BenchmarkResult(
                    run_id=run_id,
                    benchmark_type="regression",
                    metrics=body.get("aggregate", {}),
                    per_query=body.get("per_query", []),
                    triggered_by=_user.username,
                    started_at=now,
                    completed_at=datetime.now(UTC),
                )
            )
            await session.commit()
    except Exception:
        logger.warning("benchmark_import_failed", exc_info=True)
        return {"ok": False, "error": "persist failed"}
    return {"ok": True, "run_id": run_id, "benchmark_type": "regression"}


@router.post("/benchmarks/run")
async def benchmark_run(_user: UserInfo = Depends(get_current_user)):
    """Trigger a lightweight connectivity benchmark (quick probe).

    This is NOT the full regression benchmark from ``bench_hybrid.py``.
    For full benchmarks, use ``POST /benchmarks/import`` or run the
    quality-runner CronJob.
    """
    _ensure_org_content_admin(_user)
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
    # v13 trust attribution
    "scan_signals",
    "review_trace_id",
    "effective_at_epoch",
    "crawl_timestamp",
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


import math as _math
import time as _time

_FRESHNESS_HALF_LIFE_DAYS = 90
_ONE_DAY_S = 86400


def _compute_freshness(row: dict) -> float:
    """Compute a 0.0–1.0 freshness score from epoch-second timestamps."""
    ts = row.get("effective_at_epoch") or row.get("crawl_timestamp") or 0
    if not ts or ts <= 0:
        return 0.0
    age_days = max(0, (_time.time() - ts) / _ONE_DAY_S)
    return _math.exp((-0.693 * age_days) / _FRESHNESS_HALF_LIFE_DAYS)


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
    _ensure_org_observability(_user)
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
    sort: str = Query("", description="Sort pivot: freshness | authority | scan_status"),
    domain: str = Query("", description="Filter by domain"),
):
    """List chunks needing review with optional sort pivots and domain filter."""
    _ensure_org_observability(_user)
    if status == "all":
        expr = 'scan_status in ["flagged", "unscanned"]'
    else:
        expr = f'scan_status == "{status}"'
    if domain:
        safe_domain = domain.replace('"', '\\"')
        expr = f'({expr}) and domain == "{safe_domain}"'
    rows = safe_query(CATALOG_COLLECTION, filter_expr=expr, output_fields=_REVIEW_FIELDS, limit=limit, offset=offset)
    for r in rows:
        full_text = r.pop("text", "")
        r["text_preview"] = full_text[:500]
        if r.get("scan_status") == "flagged" and full_text:
            r["flag_reasons"] = _detect_flag_reasons(full_text)
        else:
            r["flag_reasons"] = []
        r["freshness_score"] = _compute_freshness(r)

    if sort == "freshness":
        rows.sort(key=lambda r: r.get("freshness_score", 0), reverse=True)
    elif sort == "authority":
        tier_order = {"canonical": 0, "vetted": 1, "community": 2, "external": 3}
        rows.sort(key=lambda r: tier_order.get(r.get("authority", ""), 99))
    elif sort == "scan_status":
        status_order = {"flagged": 0, "unscanned": 1, "clean": 2, "vetted": 3}
        rows.sort(key=lambda r: status_order.get(r.get("scan_status", ""), 99))

    return {"chunks": rows, "offset": offset, "limit": limit}


@router.post("/review/{chunk_id}/vet")
async def vet_chunk(chunk_id: str, _user: UserInfo = Depends(get_current_user)):
    """Mark a chunk as vetted: set scan_status to 'vetted', approval_status to 'approved'."""
    _ensure_org_content_admin(_user)
    import uuid

    from ..services.nornic_service import safe_query as sq, safe_upsert

    rows = sq(
        CATALOG_COLLECTION, filter_expr=f'chunk_id == "{chunk_id}"', output_fields=["authority", "scan_status"], limit=1
    )
    if not rows:
        return {"ok": False, "error": "chunk not found"}

    trace_id = f"review-{uuid.uuid4().hex[:12]}"
    try:
        safe_upsert(
            CATALOG_COLLECTION,
            {
                "id": chunk_id,
                "chunk_id": chunk_id,
                "scan_status": "vetted",
                "authority": "vetted",
                "approval_status": "approved",
                "review_trace_id": trace_id,
            },
        )
    except Exception:
        logger.warning("review_vet_nornic_update_failed", extra={"chunk_id": chunk_id}, exc_info=True)
        return {"ok": False, "error": "graph update failed"}
    logger.info("review_vet_chunk", extra={"chunk_id": chunk_id, "user": _user.username, "review_trace_id": trace_id})
    return {"ok": True, "chunk_id": chunk_id, "action": "vetted", "review_trace_id": trace_id}


@router.post("/review/{chunk_id}/reject")
async def reject_chunk(chunk_id: str, _user: UserInfo = Depends(get_current_user)):
    """Mark a chunk as rejected: set approval_status to 'rejected' (excluded from RAG retrieval)."""
    _ensure_org_content_admin(_user)
    import uuid

    trace_id = f"review-{uuid.uuid4().hex[:12]}"
    try:
        from ..services.nornic_service import safe_upsert

        safe_upsert(
            CATALOG_COLLECTION,
            {
                "id": chunk_id,
                "chunk_id": chunk_id,
                "scan_status": "rejected",
                "approval_status": "rejected",
                "review_trace_id": trace_id,
            },
        )
        ok = True
    except Exception:
        logger.warning("review_reject_nornic_update_failed", extra={"chunk_id": chunk_id}, exc_info=True)
        ok = False
    logger.info(
        "review_reject_chunk",
        extra={"chunk_id": chunk_id, "user": _user.username, "ok": ok, "review_trace_id": trace_id},
    )
    return {"ok": ok, "chunk_id": chunk_id, "action": "rejected", "review_trace_id": trace_id}


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
    _ensure_org_content_admin(_user)
    import uuid

    chunk_ids = request.get("chunk_ids", [])
    if not chunk_ids:
        return {"ok": False, "error": "no chunk_ids provided"}
    if action not in ("vet", "reject"):
        return {"ok": False, "error": "action must be 'vet' or 'reject'"}

    batch_trace_id = f"review-batch-{uuid.uuid4().hex[:12]}"
    results: dict[str, Any] = {"ok": True, "processed": 0, "errors": 0, "review_trace_id": batch_trace_id}
    from ..services.nornic_service import safe_upsert

    for chunk_id in chunk_ids:
        try:
            if action == "vet":
                safe_upsert(
                    CATALOG_COLLECTION,
                    {
                        "id": chunk_id,
                        "chunk_id": chunk_id,
                        "scan_status": "vetted",
                        "authority": "vetted",
                        "approval_status": "approved",
                        "review_trace_id": batch_trace_id,
                    },
                )
            else:
                safe_upsert(
                    CATALOG_COLLECTION,
                    {
                        "id": chunk_id,
                        "chunk_id": chunk_id,
                        "scan_status": "rejected",
                        "approval_status": "rejected",
                        "review_trace_id": batch_trace_id,
                    },
                )
            results["processed"] += 1
        except Exception:
            logger.warning("review_bulk_%s_failed", action, extra={"chunk_id": chunk_id}, exc_info=True)
            results["errors"] += 1

    logger.info(
        "review_bulk_action",
        extra={
            "action": action,
            "count": len(chunk_ids),
            "processed": results["processed"],
            "user": _user.username,
            "review_trace_id": batch_trace_id,
        },
    )
    return results
