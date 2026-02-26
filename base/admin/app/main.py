"""Synesis Admin Service -- failure dashboard and gap analysis.

Lightweight FastAPI service exposing a simple HTML dashboard for
browsing failure patterns, aggregate stats, and RAG corpus gaps.
Internal-only (no Route/Ingress).
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.admin")

app = FastAPI(title="Synesis Admin", version="0.1.0")

TEMPLATES_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

MILVUS_HOST = os.getenv("SYNESIS_MILVUS_HOST", "milvus.synesis-rag.svc.cluster.local")
MILVUS_PORT = int(os.getenv("SYNESIS_MILVUS_PORT", "19530"))
FAILURES_COLLECTION = "failures_v1"

_client = None


def _get_client():
    global _client
    if _client is None:
        from pymilvus import MilvusClient
        _client = MilvusClient(uri=f"http://{MILVUS_HOST}:{MILVUS_PORT}")
    return _client


def _safe_query(filter_expr: str = "", output_fields: list[str] | None = None, limit: int = 100, offset: int = 0) -> list[dict]:
    try:
        client = _get_client()
        if FAILURES_COLLECTION not in client.list_collections():
            return []
        return client.query(
            collection_name=FAILURES_COLLECTION,
            filter=filter_expr if filter_expr else "",
            output_fields=output_fields or [],
            limit=limit,
            offset=offset,
        )
    except Exception as e:
        logger.warning(f"Milvus query error: {e}")
        return []


@app.get("/admin/health")
async def health():
    return {"status": "ok", "service": "synesis-admin"}


@app.get("/admin/failures", response_class=HTMLResponse)
async def failures_list(
    request: Request,
    language: str = Query("", description="Filter by language"),
    error_type: str = Query("", description="Filter by error type"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    filter_parts = []
    if language:
        filter_parts.append(f'language == "{language}"')
    if error_type:
        filter_parts.append(f'error_type == "{error_type}"')
    filter_expr = " and ".join(filter_parts)

    offset = (page - 1) * page_size
    failures = _safe_query(
        filter_expr=filter_expr,
        output_fields=[
            "failure_id", "code", "error_output", "exit_code",
            "error_type", "language", "task_description", "resolution", "timestamp",
        ],
        limit=page_size,
        offset=offset,
    )

    return templates.TemplateResponse("failures.html", {
        "request": request,
        "failures": failures,
        "language": language,
        "error_type": error_type,
        "page": page,
        "page_size": page_size,
    })


@app.get("/admin/failures/stats", response_class=HTMLResponse)
async def failures_stats(request: Request):
    all_failures = _safe_query(
        output_fields=["error_type", "language", "resolution", "timestamp"],
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

    return templates.TemplateResponse("stats.html", {
        "request": request,
        "total": total,
        "resolved": resolved,
        "unresolved": total - resolved,
        "by_language": by_language,
        "by_error_type": by_error_type,
    })


@app.get("/admin/failures/gaps", response_class=HTMLResponse)
async def failures_gaps(request: Request):
    """Identify RAG corpus gaps: failures with no resolution suggest missing docs."""
    unresolved = _safe_query(
        filter_expr='resolution == ""',
        output_fields=["failure_id", "language", "task_description", "error_type", "error_output"],
        limit=100,
    )

    gap_clusters: dict[str, list[dict]] = {}
    for f in unresolved:
        lang = f.get("language", "unknown")
        if lang not in gap_clusters:
            gap_clusters[lang] = []
        gap_clusters[lang].append(f)

    return templates.TemplateResponse("gaps.html", {
        "request": request,
        "gap_clusters": gap_clusters,
        "total_unresolved": len(unresolved),
    })


@app.get("/admin/failures/{failure_id}", response_class=HTMLResponse)
async def failure_detail(request: Request, failure_id: str):
    results = _safe_query(
        filter_expr=f'failure_id == "{failure_id}"',
        output_fields=[
            "failure_id", "code", "error_output", "exit_code",
            "error_type", "language", "task_description", "resolution", "timestamp",
        ],
        limit=1,
    )

    failure = results[0] if results else None
    return templates.TemplateResponse("detail.html", {
        "request": request,
        "failure": failure,
    })


@app.get("/admin/api/failures/stats")
async def api_failures_stats():
    """JSON API for programmatic access."""
    all_failures = _safe_query(
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
