"""Synesis Admin Service -- failure dashboard and gap analysis.

Lightweight FastAPI service exposing a simple HTML dashboard for
browsing failure patterns, aggregate stats, and RAG corpus gaps.
Internal-only (no Route/Ingress).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import httpx
from fastapi import FastAPI, Form, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.admin")

app = FastAPI(title="Synesis Admin", version="0.1.0")

TEMPLATES_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

MILVUS_HOST = os.getenv("SYNESIS_MILVUS_HOST", "synesis-milvus.synesis-rag.svc.cluster.local")
MILVUS_PORT = int(os.getenv("SYNESIS_MILVUS_PORT", "19530"))
PLANNER_URL = os.getenv("SYNESIS_PLANNER_URL", "http://synesis-planner.synesis-planner.svc.cluster.local:8000")
PLANNER_URL = os.getenv("SYNESIS_PLANNER_URL", "http://synesis-planner.synesis-planner.svc.cluster.local:8000")
FAILURES_COLLECTION = "failures_v1"
KNOWLEDGE_BACKLOG_COLLECTION = "synesis_knowledge_backlog"

_client = None


def _get_client():
    global _client
    if _client is None:
        from pymilvus import MilvusClient

        _client = MilvusClient(uri=f"http://{MILVUS_HOST}:{MILVUS_PORT}")
    return _client


def _safe_query(
    filter_expr: str = "",
    output_fields: list[str] | None = None,
    limit: int = 100,
    offset: int = 0,
    collection: str = FAILURES_COLLECTION,
) -> list[dict]:
    try:
        client = _get_client()
        if collection not in client.list_collections():
            return []
        try:
            return client.query(
                collection_name=collection,
                filter=filter_expr if filter_expr else "",
                output_fields=output_fields or [],
                limit=limit,
                offset=offset,
            )
        except Exception as e:
            if "collection not loaded" in str(e).lower():
                try:
                    client.load_collection(collection_name=collection)
                    return client.query(
                        collection_name=collection,
                        filter=filter_expr if filter_expr else "",
                        output_fields=output_fields or [],
                        limit=limit,
                        offset=offset,
                    )
                except Exception as retry_e:
                    logger.warning(f"Milvus query retry failed: {retry_e}")
                    return []
            raise
    except Exception as e:
        logger.warning(f"Milvus query error: {e}")
        return []


# Service endpoints to probe (vLLM uses /health at root; planner/Milvus use their own paths)
STATUS_SERVICES = [
    {
        "name": "synesis-supervisor",
        "url": "http://synesis-supervisor-predictor.synesis-models.svc.cluster.local:8080/health",
    },
    {
        "name": "synesis-executor",
        "url": "http://synesis-executor-predictor.synesis-models.svc.cluster.local:8080/health",
    },
    {"name": "synesis-critic", "url": "http://synesis-critic-predictor.synesis-models.svc.cluster.local:8080/health"},
    {"name": "synesis-planner", "url": "http://synesis-planner.synesis-planner.svc.cluster.local:8000/health"},
    {"name": "milvus", "url": "http://synesis-milvus.synesis-rag.svc.cluster.local:9091/healthz"},
    {"name": "embedder", "url": "http://embedder.synesis-rag.svc.cluster.local:8080/health"},
    {"name": "lsp-gateway", "url": "http://lsp-gateway.synesis-lsp.svc:8000/health"},
]


@app.get("/")
async def root():
    return RedirectResponse(url="/admin/status", status_code=302)


@app.get("/admin/health")
async def health():
    return {"status": "ok", "service": "synesis-admin"}


async def _probe_service(client: httpx.AsyncClient, svc: dict, timeout: float = 5.0) -> dict:
    try:
        resp = await client.get(svc["url"], timeout=timeout)
        return {
            "name": svc["name"],
            "status": "ok" if resp.status_code < 500 else "error",
            "status_code": resp.status_code,
            "error": None,
        }
    except Exception as e:
        return {
            "name": svc["name"],
            "status": "error",
            "status_code": None,
            "error": str(e)[:80],
        }


@app.get("/admin/status", response_class=HTMLResponse)
async def status_page(request: Request):
    results = []
    async with httpx.AsyncClient() as client:
        for svc in STATUS_SERVICES:
            r = await _probe_service(client, svc)
            results.append(r)
    return templates.TemplateResponse(
        "status.html",
        {"request": request, "services": results},
    )


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

    return templates.TemplateResponse(
        "failures.html",
        {
            "request": request,
            "failures": failures,
            "language": language,
            "error_type": error_type,
            "page": page,
            "page_size": page_size,
        },
    )


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

    return templates.TemplateResponse(
        "stats.html",
        {
            "request": request,
            "total": total,
            "resolved": resolved,
            "unresolved": total - resolved,
            "by_language": by_language,
            "by_error_type": by_error_type,
        },
    )


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

    return templates.TemplateResponse(
        "gaps.html",
        {
            "request": request,
            "gap_clusters": gap_clusters,
            "total_unresolved": len(unresolved),
        },
    )


@app.get("/admin/failures/{failure_id}", response_class=HTMLResponse)
async def failure_detail(request: Request, failure_id: str):
    results = _safe_query(
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

    failure = results[0] if results else None
    return templates.TemplateResponse(
        "detail.html",
        {
            "request": request,
            "failure": failure,
        },
    )


@app.get("/admin/knowledge-gaps", response_class=HTMLResponse)
async def knowledge_gaps_list(
    request: Request,
    domain: str = Query("", description="Filter by domain/platform_context"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """Knowledge gaps — queries with low RAG confidence. Self-heal: review and submit content to fill."""
    filter_parts = []
    if domain:
        filter_parts.append(f'platform_context == "{domain}"')
    filter_expr = " and ".join(filter_parts)

    offset = (page - 1) * page_size
    gaps = _safe_query(
        collection=KNOWLEDGE_BACKLOG_COLLECTION,
        filter_expr=filter_expr,
        output_fields=["chunk_id", "query", "task_description", "collections_queried", "max_score", "platform_context", "timestamp", "language"],
        limit=page_size,
        offset=offset,
    )

    return templates.TemplateResponse(
        "knowledge_gaps.html",
        {
            "request": request,
            "gaps": gaps,
            "domain": domain,
            "page": page,
            "page_size": page_size,
        },
    )


@app.post("/admin/knowledge-gaps/submit")
async def knowledge_gaps_submit(
    domain: str = Form(...),
    content: str = Form(...),
):
    """Forward submit to planner. Ingests into synesis_catalog."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.post(
                f"{PLANNER_URL.rstrip('/')}/v1/knowledge/submit",
                json={"domain": domain.strip() or "generalist", "content": content.strip()},
            )
            resp.raise_for_status()
            return RedirectResponse(url="/admin/knowledge-gaps?submitted=1", status_code=303)
        except Exception as e:
            logger.warning(f"Knowledge submit failed: {e}")
            return RedirectResponse(url=f"/admin/knowledge-gaps?error={str(e)[:50]}", status_code=303)


@app.get("/admin/api/knowledge-gaps")
async def api_knowledge_gaps(limit: int = Query(50, ge=1, le=200)):
    """JSON API for knowledge gaps (Open WebUI Functions, dashboards)."""
    gaps = _safe_query(
        collection=KNOWLEDGE_BACKLOG_COLLECTION,
        output_fields=["chunk_id", "query", "task_description", "collections_queried", "max_score", "platform_context", "timestamp", "language"],
        limit=limit,
    )
    return {"gaps": gaps, "total": len(gaps)}


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
