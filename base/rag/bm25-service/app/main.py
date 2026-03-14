"""BM25 keyword search microservice.

Owns the in-memory BM25 index built from Milvus. Planner replicas call
POST /v1/search instead of holding the index in-process.

Background refresh runs every BM25_REFRESH_INTERVAL_SECONDS (default 1800).
POST /v1/refresh triggers an immediate rebuild (e.g. after data loads).
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from synesis_telemetry import configure_logging, get_logger

from .index import BM25Index

configure_logging(service="synesis-bm25-service")
logger = get_logger("synesis.bm25_service")

_DEFAULT_COLLECTION = os.getenv("BM25_DEFAULT_COLLECTION", "synesis_catalog")
_REFRESH_INTERVAL = int(os.getenv("BM25_REFRESH_INTERVAL_SECONDS", "1800"))

_index = BM25Index()
_refresh_task: asyncio.Task | None = None


async def _background_refresh() -> None:
    """Periodically refresh all known collections + the default."""
    while True:
        collections = set(_index.collections().keys())
        collections.add(_DEFAULT_COLLECTION)
        for coll in collections:
            if _index.needs_refresh(coll):
                try:
                    await asyncio.to_thread(_index.refresh, coll)
                except Exception as e:
                    logger.warning("bg_refresh_error", extra={
                        "collection": coll, "error": str(e)[:200],
                    })
        await asyncio.sleep(min(_REFRESH_INTERVAL, 60))


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _refresh_task
    logger.info("bm25_service_starting", extra={
        "default_collection": _DEFAULT_COLLECTION,
        "refresh_interval": _REFRESH_INTERVAL,
    })
    try:
        await asyncio.to_thread(_index.refresh, _DEFAULT_COLLECTION)
    except Exception as e:
        logger.warning("initial_refresh_failed", extra={"error": str(e)[:200]})
    _refresh_task = asyncio.create_task(_background_refresh())
    yield
    _refresh_task.cancel()


app = FastAPI(title="Synesis BM25 Service", lifespan=lifespan)


class SearchRequest(BaseModel):
    query: str
    collection: str = Field(default="synesis_catalog")
    top_k: int = Field(default=10, ge=1, le=200)


class SearchResult(BaseModel):
    results: list[dict]


class RefreshRequest(BaseModel):
    collection: str = Field(default="synesis_catalog")


class RefreshResponse(BaseModel):
    status: str
    collection: str
    chunk_count: int


@app.get("/health")
async def health():
    info = _index.collections()
    return {
        "status": "ok",
        "collections": info,
        "refreshing": {
            c: _index.is_refreshing(c) for c in info
        },
    }


@app.post("/v1/search", response_model=SearchResult)
async def search(req: SearchRequest):
    if not req.query or not req.query.strip():
        return SearchResult(results=[])
    snap = _index.collections().get(req.collection)
    if snap is None and not _index.is_refreshing(req.collection):
        try:
            await asyncio.to_thread(_index.refresh, req.collection)
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"Index not ready: {e}") from e
    try:
        results = await asyncio.to_thread(
            _index.search, req.query, req.collection, req.top_k,
        )
        return SearchResult(results=results)
    except Exception as e:
        logger.exception("bm25_search_failed")
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.post("/v1/refresh", response_model=RefreshResponse)
async def refresh(req: RefreshRequest):
    try:
        await asyncio.to_thread(_index.refresh, req.collection)
    except Exception as e:
        logger.exception("bm25_refresh_failed")
        raise HTTPException(status_code=502, detail=str(e)) from e
    info = _index.collections().get(req.collection, {})
    return RefreshResponse(
        status="ok",
        collection=req.collection,
        chunk_count=info.get("chunk_count", 0),
    )
