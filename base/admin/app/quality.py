"""Quality dashboard routes for the Synesis Admin service.

Provides a web UI and JSON API for reviewing corpus audit results, domain
health scorecards, and curator source proposals.  Data comes from two sources:

1. **Live Milvus queries** — real-time chunk counts per domain.
2. **Audit report files** — JSON/YAML written by the quality-runner CronJob
   (or local CLI runs) and mounted into the admin pod.
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from synesis_telemetry import get_logger

logger = get_logger("synesis.admin.quality")

router = APIRouter(prefix="/admin")

TEMPLATES_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

QUALITY_REPORT_PATH = os.getenv(
    "SYNESIS_QUALITY_REPORT_PATH",
    "/data/quality/corpus_audit_report.json",
)
CURATOR_PROPOSALS_PATH = os.getenv(
    "SYNESIS_CURATOR_PROPOSALS_PATH",
    "/data/quality/proposed_sources.yaml",
)

COLLECTION = "synesis_catalog"

_milvus_client = None


def _get_client():
    global _milvus_client
    if _milvus_client is None:
        from pymilvus import MilvusClient

        host = os.getenv("SYNESIS_MILVUS_HOST", "synesis-milvus.synesis-rag.svc.cluster.local")
        port = int(os.getenv("SYNESIS_MILVUS_PORT", "19530"))
        _milvus_client = MilvusClient(uri=f"http://{host}:{port}")
    return _milvus_client


# ---------------------------------------------------------------------------
# Data loaders
# ---------------------------------------------------------------------------

def _load_audit_report() -> dict[str, Any] | None:
    """Load the latest audit report from the shared filesystem."""
    for path in [QUALITY_REPORT_PATH, "benchmarks/corpus/corpus_audit_report.json"]:
        p = Path(path)
        if p.exists():
            try:
                with open(p) as f:
                    return json.load(f)
            except Exception as e:
                logger.warning("failed_to_load_audit_report path=%s error=%s", path, e)
    return None


def _load_curator_proposals() -> dict[str, Any] | None:
    """Load curator proposals from the shared filesystem."""
    for path in [CURATOR_PROPOSALS_PATH, "tools/curator/proposed_sources.yaml"]:
        p = Path(path)
        if p.exists():
            try:
                with open(p) as f:
                    return yaml.safe_load(f)
            except Exception as e:
                logger.warning("failed_to_load_curator_proposals path=%s error=%s", path, e)
    return None


def _live_domain_stats() -> dict[str, int]:
    """Query Milvus for real-time chunk counts per domain."""
    try:
        client = _get_client()
        if COLLECTION not in client.list_collections():
            return {}
        results = client.query(
            collection_name=COLLECTION,
            filter="",
            output_fields=["domain"],
            limit=16384,
        )
        counts: dict[str, int] = defaultdict(int)
        for r in results:
            domain = r.get("domain", "unknown")
            counts[domain] += 1
        return dict(counts)
    except Exception as e:
        logger.warning("live_domain_stats_error error=%s", e)
        return {}


# ---------------------------------------------------------------------------
# HTML pages
# ---------------------------------------------------------------------------

@router.get("/quality", response_class=HTMLResponse)
async def quality_dashboard(request: Request):
    """Main quality dashboard: summary + domain health table."""
    report = _load_audit_report()
    live_stats = _live_domain_stats()

    scorecards = []
    summary = {"strong": 0, "adequate": 0, "weak": 0, "empty": 0, "total_chunks": 0}

    if report:
        scorecards = report.get("scorecards", [])
        summary = report.get("summary", summary)
        summary["total_chunks"] = sum(
            s.get("inventory", {}).get("total_chunks", 0) for s in scorecards
        )

    return templates.TemplateResponse(
        "quality.html",
        {
            "request": request,
            "report": report,
            "scorecards": scorecards,
            "summary": summary,
            "live_stats": live_stats,
            "total_live_chunks": sum(live_stats.values()),
        },
    )


@router.get("/quality/domain/{domain_key}", response_class=HTMLResponse)
async def quality_domain_detail(request: Request, domain_key: str):
    """Detailed scorecard for a single domain."""
    report = _load_audit_report()
    scorecard = None

    if report:
        for sc in report.get("scorecards", []):
            if sc.get("domain") == domain_key:
                scorecard = sc
                break

    live_count = 0
    try:
        live_stats = _live_domain_stats()
        live_count = live_stats.get(domain_key, 0)
    except Exception:
        pass

    return templates.TemplateResponse(
        "quality_domain.html",
        {
            "request": request,
            "domain_key": domain_key,
            "scorecard": scorecard,
            "live_count": live_count,
        },
    )


@router.get("/quality/curator", response_class=HTMLResponse)
async def quality_curator(request: Request):
    """Review curator proposals."""
    proposals = _load_curator_proposals()

    domain_proposals = []
    total_sources = 0
    if proposals:
        domain_proposals = proposals.get("proposals", [])
        total_sources = proposals.get("total_sources", 0)

    return templates.TemplateResponse(
        "quality_curator.html",
        {
            "request": request,
            "proposals": proposals,
            "domain_proposals": domain_proposals,
            "total_sources": total_sources,
        },
    )


# ---------------------------------------------------------------------------
# JSON APIs
# ---------------------------------------------------------------------------

@router.get("/api/quality/summary")
async def api_quality_summary():
    """JSON summary of corpus quality."""
    report = _load_audit_report()
    live_stats = _live_domain_stats()

    if not report:
        return {
            "status": "no_report",
            "message": "No audit report available. Run: make bench-corpus-audit",
            "live_stats": {
                "total_domains": len(live_stats),
                "total_chunks": sum(live_stats.values()),
            },
        }

    return {
        "status": "ok",
        "summary": report.get("summary", {}),
        "domains_audited": report.get("domains_audited", 0),
        "elapsed_seconds": report.get("elapsed_seconds", 0),
        "weak_domains": report.get("weak_domains", []),
        "empty_domains": report.get("empty_domains", []),
        "live_stats": {
            "total_domains": len(live_stats),
            "total_chunks": sum(live_stats.values()),
        },
    }


@router.get("/api/quality/domains")
async def api_quality_domains(
    health: str = Query("", description="Filter by health: strong, adequate, weak, empty"),
    sort_by: str = Query("health", description="Sort by: health, hit_rate, chunks, mrr"),
):
    """All domain scorecards with optional filtering."""
    report = _load_audit_report()
    if not report:
        return {"status": "no_report", "domains": []}

    scorecards = report.get("scorecards", [])
    if health:
        scorecards = [s for s in scorecards if s.get("health") == health]

    sort_keys = {
        "health": lambda s: ({"weak": 0, "adequate": 1, "strong": 2, "empty": 3}.get(s.get("health", ""), 99)),
        "hit_rate": lambda s: -s.get("coverage", {}).get("hit_rate", 0),
        "chunks": lambda s: -s.get("inventory", {}).get("total_chunks", 0),
        "mrr": lambda s: -s.get("coverage", {}).get("mean_mrr", 0),
    }
    scorecards.sort(key=sort_keys.get(sort_by, sort_keys["health"]))

    return {"status": "ok", "domains": scorecards}


@router.get("/api/quality/domain/{domain_key}")
async def api_quality_domain(domain_key: str):
    """Single domain scorecard."""
    report = _load_audit_report()
    if not report:
        return {"status": "no_report"}

    for sc in report.get("scorecards", []):
        if sc.get("domain") == domain_key:
            return {"status": "ok", "scorecard": sc}

    return {"status": "not_found", "domain": domain_key}


@router.get("/api/quality/curator")
async def api_quality_curator():
    """Curator proposals."""
    proposals = _load_curator_proposals()
    if not proposals:
        return {
            "status": "no_proposals",
            "message": "No curator proposals available. Run: make curator-discover",
        }

    return {"status": "ok", **proposals}
