"""Hybrid RAG retrieval client with cross-encoder re-ranking.

Supports three retrieval strategies via Milvus native search:
  - "vector": Milvus cosine similarity (semantic, HNSW on embedding)
  - "bm25": Milvus native BM25 (sparse search on sparse_text field)
  - "hybrid": Both arms merged server-side via Milvus RRFRanker

Cross-encoder re-rankers (applied after retrieval):
  - "flashrank": Ultra-fast inline (~4ms), no PyTorch needed
  - "bge": High-accuracy via external BGE service
  - "none": Skip re-ranking

All retrieval goes through Milvus — no external BM25 microservice needed.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import threading
import time
from typing import Any

import httpx

from .config import settings
from .state import RetrievalResult
from .url_utils import ensure_url_protocol

logger = logging.getLogger("synesis.rag")

# Unified catalog (synesis_catalog) — single collection with HNSW + BM25 indexes.
# Schema must match base/rag/indexer/app/schema.py for indexer compatibility.
SYNESIS_CATALOG = "synesis_catalog"

_http_client: httpx.AsyncClient | None = None
_http_client_lock = asyncio.Lock()

# ---------------------------------------------------------------------------
# Prometheus metrics (registered lazily to avoid import-time side effects)
# ---------------------------------------------------------------------------
_metrics_registered = False
_retrieval_source_counter = None
_reranker_latency_histogram = None
_bm25_fallback_counter = None


def _ensure_metrics():
    global _metrics_registered, _retrieval_source_counter
    global _reranker_latency_histogram, _bm25_fallback_counter
    if _metrics_registered:
        return
    try:
        from prometheus_client import Counter, Histogram

        _retrieval_source_counter = Counter(
            "synesis_retrieval_source_total",
            "Count of retrieval results by source",
            ["source"],
        )
        _reranker_latency_histogram = Histogram(
            "synesis_reranker_duration_seconds",
            "Cross-encoder re-ranking latency",
            ["reranker"],
            buckets=[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
        )
        _bm25_fallback_counter = Counter(
            "synesis_bm25_fallback_total",
            "Times retrieval fell back to BM25-only due to vector service failure",
        )
    except Exception:  # nosec B110
        pass
    _metrics_registered = True


async def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is not None:
        return _http_client
    async with _http_client_lock:
        if _http_client is None:
            _http_client = httpx.AsyncClient(timeout=30.0)
        return _http_client


# ---------------------------------------------------------------------------
# Embedding helper
# ---------------------------------------------------------------------------


async def _embed_text(text: str) -> list[float]:
    """Get embedding vector from the embedder service."""
    base = ensure_url_protocol(settings.embedder_url)
    client = await _get_client()
    response = await client.post(
        f"{base.rstrip('/')}/embeddings",
        json={"input": text, "model": settings.embedder_model},
    )
    response.raise_for_status()
    data = response.json()
    try:
        return data["data"][0]["embedding"]
    except (KeyError, IndexError, TypeError) as exc:
        logger.error(
            "embed_text_malformed_response",
            extra={"keys": list(data.keys()) if isinstance(data, dict) else type(data).__name__},
            exc_info=True,
        )
        raise ValueError(f"Embedder returned malformed response: {exc}") from exc


async def _batch_embed_texts(texts: list[str]) -> list[list[float]]:
    """Batch-embed multiple texts in a single TEI call."""
    if not texts:
        return []
    if len(texts) == 1:
        return [await _embed_text(texts[0])]
    base = ensure_url_protocol(settings.embedder_url)
    client = await _get_client()
    response = await client.post(
        f"{base.rstrip('/')}/embeddings",
        json={"input": texts, "model": settings.embedder_model},
    )
    response.raise_for_status()
    data = response.json()
    try:
        items = sorted(data["data"], key=lambda d: d["index"])
        return [item["embedding"] for item in items]
    except (KeyError, IndexError, TypeError) as exc:
        logger.error("batch_embed_malformed_response", exc_info=True)
        raise ValueError(f"Embedder batch response malformed: {exc}") from exc


# ---------------------------------------------------------------------------
# Milvus timeout for direct connections (catalog bootstrap, vector search)
# ---------------------------------------------------------------------------

_MILVUS_TIMEOUT = 10
# Best-effort probe during FastAPI lifespan so a slow/unreachable Milvus does not block startup for 4× full RPC timeouts.
_MILVUS_STARTUP_CONNECT_TIMEOUT = 5.0

# ---------------------------------------------------------------------------
# Milvus client pool — enables truly parallel hybrid_search via asyncio.to_thread
# ---------------------------------------------------------------------------

_milvus_pool: asyncio.Queue | None = None
_milvus_pool_async_lock = asyncio.Lock()

_CONNECTION_DEAD_MARKERS = (
    "closed channel",
    "Cannot invoke RPC",
    "connection reset",
    "Connection refused",
    "rpc error",
    "unavailable",
    "connection reset by peer",
    "failed to connect to all addresses",
)


def _is_connection_dead_error(exc: BaseException) -> bool:
    """True if the exception indicates the Milvus gRPC channel is no longer usable."""
    msg = (getattr(exc, "message", None) or str(exc)).lower()
    return any(marker.lower() in msg for marker in _CONNECTION_DEAD_MARKERS)


def _evict_dead_alias(client) -> None:
    """Remove a dead client's connection alias from pymilvus's internal registry.

    Without this, pymilvus reuses the dead gRPC channel when a new
    MilvusClient is created, causing cascading pool failures.
    """
    try:
        from pymilvus.orm.connections import connections

        alias = getattr(client, "_using", None)
        if alias and connections.has_connection(alias):
            connections.remove_connection(alias)
            logger.debug("milvus_alias_evicted", extra={"alias": alias})
    except Exception:
        pass


def _try_create_milvus_client(*, timeout: float | None = None) -> Any | None:
    """Return a connected MilvusClient or None (logs at debug)."""
    try:
        from pymilvus import MilvusClient

        t = float(timeout) if timeout is not None else float(_MILVUS_TIMEOUT)
        return MilvusClient(
            uri=f"http://{settings.milvus_host}:{settings.milvus_port}",
            timeout=t,
        )
    except Exception as e:
        logger.debug("milvus_client_create_failed", extra={"error": str(e)[:240]})
        return None


def _create_milvus_client():
    """Create a client or raise — for paths that require a hard failure."""
    c = _try_create_milvus_client()
    if c is None:
        raise ConnectionError(
            f"Milvus unavailable at {settings.milvus_host}:{settings.milvus_port}",
        )
    return c


def _connect_clients_sync(count: int, connect_timeout: float | None) -> list[Any]:
    """Blocking Milvus handshakes — run via asyncio.to_thread (never create asyncio.Queue there)."""
    out: list[Any] = []
    for _ in range(count):
        c = _try_create_milvus_client(timeout=connect_timeout)
        if c is not None:
            out.append(c)
    return out


async def _ensure_milvus_pool_async() -> asyncio.Queue:
    """Lazily build the pool on the event-loop thread; connect clients in a worker thread."""
    global _milvus_pool
    if _milvus_pool is not None:
        return _milvus_pool
    async with _milvus_pool_async_lock:
        if _milvus_pool is not None:
            return _milvus_pool
        n = getattr(settings, "milvus_pool_size", 4)
        clients = await asyncio.to_thread(_connect_clients_sync, n, None)
        pool = asyncio.Queue(maxsize=n)
        for c in clients:
            pool.put_nowait(c)
        _milvus_pool = pool
        if pool.empty():
            logger.warning(
                "milvus_pool_empty_lazy_init",
                extra={"host": settings.milvus_host, "port": settings.milvus_port},
            )
        else:
            logger.info("milvus_pool_created", extra={"size": pool.qsize()})
            ensure_milvus_keepalive()
        return pool


async def _acquire_milvus_client():
    """Acquire a client from the pool without pre-flight validation.

    Skips the expensive list_collections() round-trip.  Dead connections are
    detected and replaced inside _hybrid_search / _sparse_search retry loops.
    """
    pool = await _ensure_milvus_pool_async()
    try:
        return await asyncio.wait_for(pool.get(), timeout=5.0)
    except TimeoutError:
        logger.warning("milvus_pool_exhausted")
    c = _try_create_milvus_client()
    if c is None:
        raise ConnectionError(
            f"Milvus unavailable at {settings.milvus_host}:{settings.milvus_port}",
        )
    return c


async def _release_milvus_client(client) -> None:
    """Return a client to the pool. If pool is full, discard it."""
    pool = await _ensure_milvus_pool_async()
    with contextlib.suppress(asyncio.QueueFull):
        pool.put_nowait(client)


_keepalive_task: asyncio.Task | None = None
_KEEPALIVE_INTERVAL_S = 30  # ping pool connections every 30s


async def _keepalive_loop() -> None:
    """Background task: periodically ping all pool connections to prevent idle gRPC timeout."""
    while True:
        await asyncio.sleep(_KEEPALIVE_INTERVAL_S)
        pool = await _ensure_milvus_pool_async()
        clients: list = []
        try:
            while not pool.empty():
                clients.append(pool.get_nowait())
        except asyncio.QueueEmpty:
            pass
        for c in clients:
            try:
                await asyncio.to_thread(c.list_collections)
            except Exception:
                logger.debug("keepalive_replace_dead")
                _evict_dead_alias(c)
                c = _try_create_milvus_client()
                if c is None:
                    continue
            with contextlib.suppress(asyncio.QueueFull):
                pool.put_nowait(c)


def ensure_milvus_keepalive() -> None:
    """Start the background keepalive task if not already running."""
    global _keepalive_task
    if _keepalive_task is None or _keepalive_task.done():
        try:
            loop = asyncio.get_running_loop()
            _keepalive_task = loop.create_task(_keepalive_loop(), name="milvus_keepalive")
        except RuntimeError:
            pass


async def warm_milvus_pool() -> None:
    """Proactive pool health check — call between router passes.

    Drains the pool, validates each client, replaces dead ones, and puts
    them all back. Much cheaper than discovering stale connections mid-search.
    """
    pool = await _ensure_milvus_pool_async()
    clients: list = []
    try:
        while not pool.empty():
            clients.append(pool.get_nowait())
    except asyncio.QueueEmpty:
        pass
    replaced = 0
    for c in clients:
        try:
            await asyncio.to_thread(c.list_collections)
        except Exception:
            _evict_dead_alias(c)
            c = _try_create_milvus_client()
            if c is None:
                continue
            replaced += 1
        with contextlib.suppress(asyncio.QueueFull):
            pool.put_nowait(c)
    if replaced:
        logger.info("milvus_pool_warmed", extra={"replaced": replaced, "total": len(clients)})


async def init_milvus_pool() -> None:
    """Fast Milvus probe during lifespan. Does not block the event loop for long.

    If Milvus is down, the pool stays unset until first retrieval (full timeouts there).
    """
    global _milvus_pool
    async with _milvus_pool_async_lock:
        if _milvus_pool is not None:
            ensure_milvus_keepalive()
        else:
            n = getattr(settings, "milvus_pool_size", 4)
            clients = await asyncio.to_thread(_connect_clients_sync, n, _MILVUS_STARTUP_CONNECT_TIMEOUT)
            if not clients:
                logger.warning(
                    "milvus_unreachable_at_startup",
                    extra={
                        "host": settings.milvus_host,
                        "port": settings.milvus_port,
                        "hint": "RAG returns empty until Milvus is reachable; pool initializes on first use",
                    },
                )
            else:
                pool = asyncio.Queue(maxsize=n)
                for c in clients:
                    pool.put_nowait(c)
                _milvus_pool = pool
                logger.info("milvus_pool_created", extra={"size": pool.qsize()})
                ensure_milvus_keepalive()
    logger.info("milvus_pool_init_complete")


def _get_milvus_client():
    """Synchronous accessor for non-hot-path callers (e.g. submit_user_knowledge).

    Creates a one-off client; callers that need pool parallelism should use
    _acquire/_release instead.
    """
    return _create_milvus_client()


# ---------------------------------------------------------------------------
# Unified catalog bootstrap (schema must match base/rag/indexer/app/schema.py)
# ---------------------------------------------------------------------------

_catalog_ensured = False

# Must match EXPECTED_FIELDS in base/rag/indexer/app/schema.py (SCHEMA_VERSION=10).
_EXPECTED_FIELDS = frozenset(
    {
        "chunk_id",
        "doc_id",
        "chunk_index",
        "text",
        "context_prefix",
        "chunk_summary",
        "heading_path",
        "section",
        "document_name",
        "source_type",
        "handler",
        "domain",
        "tags",
        "keywords",
        "origin_type",
        "authority",
        "source_url",
        "scan_status",
        "content_format",
        "symbol_type",
        "approval_status",
        "language",
        "repo_path",
        "module_path",
        "symbol_name",
        "artifact_kind",
        # v10 — multi-tenant isolation
        "visibility_scope",
        "org_id",
        "tenant_id",
        "content_type",
        "quality_score",
        "technical_depth",
        "domain_relevance",
        "index_decision",
        "spam_score",
        "simhash64",
        "dup_cluster_id",
        "topic_id",
        "topic_keywords",
        "crawl_timestamp",
        "entities_json",
        "section_boundaries_json",
        "raw_content_hash",
        "clean_content_hash",
        "enrichment_profile",
        "embedding",
    }
)


_catalog_fields: set[str] = set()


def _validate_catalog_schema(client) -> bool:
    """Check if the existing collection has all expected fields.

    Stores detected fields in ``_catalog_fields`` so downstream code can
    gracefully skip v8 fields that haven't been added to the collection yet.
    """
    global _catalog_fields
    try:
        desc = client.describe_collection(collection_name=SYNESIS_CATALOG)
        existing = {f.get("name", "") for f in desc.get("fields", [])}
        _catalog_fields = existing
        missing = _EXPECTED_FIELDS - existing
        if missing:
            logger.warning(
                "synesis_catalog schema drift — missing fields: %s  (searches will omit them)",
                missing,
            )
            return False
        return True
    except Exception as e:
        logger.warning("Could not validate synesis_catalog schema: %s", e)
        return False


def _recreate_catalog(client) -> bool:
    """Drop and recreate synesis_catalog with the full v10 schema.

    This is the nuclear option for schema drift — it drops all indexed data
    and recreates the collection with the correct schema.  The indexer will
    repopulate on its next run.
    """
    from pymilvus import CollectionSchema, DataType, FieldSchema, Function, FunctionType

    EMBEDDING_DIM = int(os.environ.get("SYNESIS_EMBEDDING_DIM", "384"))

    fields = [
        FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
        FieldSchema(name="doc_id", dtype=DataType.VARCHAR, max_length=128),
        FieldSchema(name="chunk_index", dtype=DataType.INT64),
        FieldSchema(
            name="text",
            dtype=DataType.VARCHAR,
            max_length=8192,
            enable_analyzer=True,
            analyzer_params={"type": "english"},
        ),
        FieldSchema(name="context_prefix", dtype=DataType.VARCHAR, max_length=512),
        FieldSchema(name="chunk_summary", dtype=DataType.VARCHAR, max_length=1024),
        FieldSchema(name="heading_path", dtype=DataType.VARCHAR, max_length=512),
        FieldSchema(name="section", dtype=DataType.VARCHAR, max_length=256),
        FieldSchema(name="document_name", dtype=DataType.VARCHAR, max_length=256),
        FieldSchema(name="source_type", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="handler", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="domain", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="tags", dtype=DataType.VARCHAR, max_length=512),
        FieldSchema(name="keywords", dtype=DataType.VARCHAR, max_length=512),
        FieldSchema(name="origin_type", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="authority", dtype=DataType.VARCHAR, max_length=32, is_partition_key=True),
        FieldSchema(name="source_url", dtype=DataType.VARCHAR, max_length=512),
        FieldSchema(name="scan_status", dtype=DataType.VARCHAR, max_length=16),
        FieldSchema(name="content_format", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="symbol_type", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="approval_status", dtype=DataType.VARCHAR, max_length=16),
        FieldSchema(name="language", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="repo_path", dtype=DataType.VARCHAR, max_length=256),
        FieldSchema(name="module_path", dtype=DataType.VARCHAR, max_length=256),
        FieldSchema(name="symbol_name", dtype=DataType.VARCHAR, max_length=128),
        FieldSchema(name="artifact_kind", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="visibility_scope", dtype=DataType.VARCHAR, max_length=16),
        FieldSchema(name="org_id", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="tenant_id", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="content_type", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="quality_score", dtype=DataType.FLOAT),
        FieldSchema(name="technical_depth", dtype=DataType.FLOAT),
        FieldSchema(name="domain_relevance", dtype=DataType.FLOAT),
        FieldSchema(name="index_decision", dtype=DataType.VARCHAR, max_length=16),
        FieldSchema(name="spam_score", dtype=DataType.FLOAT),
        FieldSchema(name="simhash64", dtype=DataType.VARCHAR, max_length=24),
        FieldSchema(name="dup_cluster_id", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="topic_id", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="topic_keywords", dtype=DataType.VARCHAR, max_length=512),
        FieldSchema(name="crawl_timestamp", dtype=DataType.INT64),
        FieldSchema(name="entities_json", dtype=DataType.VARCHAR, max_length=4096),
        FieldSchema(name="section_boundaries_json", dtype=DataType.VARCHAR, max_length=2048),
        FieldSchema(name="raw_content_hash", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="clean_content_hash", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="enrichment_profile", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
        FieldSchema(name="sparse_text", dtype=DataType.SPARSE_FLOAT_VECTOR),
    ]
    bm25_fn = Function(
        name="bm25_text_fn",
        input_field_names=["text"],
        output_field_names=["sparse_text"],
        function_type=FunctionType.BM25,
    )
    schema = CollectionSchema(fields=fields, functions=[bm25_fn], description="Synesis unified catalog v10")

    try:
        client.drop_collection(collection_name=SYNESIS_CATALOG)
        logger.warning("synesis_catalog_dropped_for_schema_upgrade")
    except Exception as e:
        logger.warning("synesis_catalog_drop_failed", extra={"error": str(e)[:200]})
        return False

    try:
        client.create_collection(collection_name=SYNESIS_CATALOG, schema=schema)
        from pymilvus import MilvusClient as _MC

        idx = _MC.prepare_index_params()
        idx.add_index(
            field_name="embedding", index_type="HNSW", metric_type="COSINE", params={"M": 16, "efConstruction": 256}
        )
        idx.add_index(field_name="sparse_text", index_type="SPARSE_INVERTED_INDEX", metric_type="BM25")
        client.create_index(collection_name=SYNESIS_CATALOG, index_params=idx)
        client.load_collection(collection_name=SYNESIS_CATALOG)
        logger.warning(
            "synesis_catalog_recreated_v10",
            extra={"detail": "Collection is empty — run the indexer to repopulate"},
        )
        return True
    except Exception as e:
        logger.error("synesis_catalog_recreate_failed", extra={"error": str(e)[:200]})
        return False


def _ensure_synesis_catalog() -> None:
    """Validate synesis_catalog exists and is loaded.

    On schema drift, drops and recreates the collection with the v10 schema
    so searches don't crash on missing fields.  The indexer repopulates data.
    """
    global _catalog_ensured
    if _catalog_ensured:
        return
    try:
        from pymilvus import MilvusClient

        client = MilvusClient(uri=f"http://{settings.milvus_host}:{settings.milvus_port}", timeout=_MILVUS_TIMEOUT)

        if SYNESIS_CATALOG not in client.list_collections():
            logger.warning(
                "synesis_catalog_not_found — creating with v10 schema",
            )
            if _recreate_catalog(client):
                _validate_catalog_schema(client)
                _catalog_ensured = True
            return

        if not _validate_catalog_schema(client):
            logger.warning(
                "synesis_catalog_schema_drift — recreating collection with v10 schema",
            )
            if _recreate_catalog(client):
                _validate_catalog_schema(client)

        _ensure_collection_loaded(client, SYNESIS_CATALOG)
        _catalog_ensured = True
        logger.info("synesis_catalog_validated", extra={"collection": SYNESIS_CATALOG})
    except Exception as e:
        logger.warning("ensure_synesis_catalog_failed", extra={"error": str(e)[:200]})


async def submit_user_knowledge(
    domain: str,
    content: str,
    source: str = "user_submitted",
    *,
    visibility_scope: str = "global",
    org_id: str = "",
    tenant_id: str = "",
) -> str | None:
    """Submit user-provided knowledge to synesis_catalog. Returns chunk_id or None on error.

    Used by self-heal flow: Admin/Open WebUI submits content to fill knowledge gaps.
    """
    import hashlib

    if not content or not content.strip():
        return None

    _ensure_synesis_catalog()
    embedding = await _embed_text(content.strip()[:8192])
    chunk_id = hashlib.sha256(f"{source}:{domain}:{content[:500]}".encode()).hexdigest()[:64]

    entity = {
        "chunk_id": chunk_id,
        "doc_id": f"user:{domain}:{chunk_id[:32]}",
        "chunk_index": 0,
        "text": content.strip()[:8192],
        "context_prefix": f"User-submitted knowledge for domain '{domain}'.",
        "chunk_summary": "",
        "heading_path": "",
        "section": "",
        "document_name": source[:256],
        "source_type": "user_submitted",
        "handler": "user_submitted",
        "domain": (domain or "generalist")[:64],
        "tags": "",
        "keywords": "",
        "origin_type": "internal",
        "authority": "vetted",
        "source_url": "",
        "scan_status": "unscanned",
        "content_format": "",
        "symbol_type": "",
        "approval_status": "auto_approved",
        "language": "",
        "repo_path": "",
        "module_path": "",
        "symbol_name": "",
        "artifact_kind": "docs",
        "visibility_scope": (visibility_scope or "global")[:16],
        "org_id": (org_id or "")[:64],
        "tenant_id": (tenant_id or "")[:64],
        "content_type": "reference",
        "quality_score": -1.0,
        "technical_depth": -1.0,
        "domain_relevance": -1.0,
        "index_decision": "index",
        "spam_score": -1.0,
        "simhash64": "",
        "dup_cluster_id": "",
        "topic_id": "",
        "topic_keywords": "",
        "crawl_timestamp": 0,
        "entities_json": "",
        "section_boundaries_json": "",
        "raw_content_hash": "",
        "clean_content_hash": "",
        "enrichment_profile": "v9_user_submit",
        "embedding": embedding,
    }

    try:
        client = _get_milvus_client()
        client.upsert(collection_name=SYNESIS_CATALOG, data=[entity])
        logger.info("knowledge_submitted", extra={"chunk_id": chunk_id[:12], "domain": domain})
        return chunk_id
    except Exception as e:
        logger.warning("submit_knowledge_failed", extra={"error": str(e)[:200]})
        return None


# ---------------------------------------------------------------------------
# Collection selection (unified catalog only)
# ---------------------------------------------------------------------------


def discover_collections() -> list[str]:
    """Return synesis_catalog. Ensures it exists and is loaded."""
    _ensure_synesis_catalog()
    return [SYNESIS_CATALOG]


def build_scope_filter(
    *,
    caller_org_id: str = "",
    caller_tenant_ids: list[str] | None = None,
) -> str:
    """Build the mandatory three-tier visibility scope predicate.

    Access tiers (OR-combined):
      1. ``visibility_scope == "global"`` — always allowed
      2. ``visibility_scope == "org"`` AND ``org_id == caller_org_id``
      3. ``visibility_scope == "tenant"`` AND ``org_id == caller_org_id``
         AND ``tenant_id in caller_tenant_ids``

    Fail-closed: if caller_org_id is empty, only global content is returned.
    """
    available = _catalog_fields
    if "visibility_scope" not in available and available:
        return ""

    clauses: list[str] = ['visibility_scope == "global"']
    if caller_org_id:
        safe_org = caller_org_id.replace('"', "")[:64]
        clauses.append(f'(visibility_scope == "org" and org_id == "{safe_org}")')
        if caller_tenant_ids:
            safe_tenants = [t.replace('"', "")[:64] for t in caller_tenant_ids[:50]]
            tenant_list = ",".join(f'"{t}"' for t in safe_tenants)
            clauses.append(
                f'(visibility_scope == "tenant" and org_id == "{safe_org}" and tenant_id in [{tenant_list}])'
            )
    return f"({' or '.join(clauses)})"


def build_metadata_filter(
    *,
    language: str = "",
    artifact_kind: str = "",
    repo_path: str = "",
    domain_filter: str = "",
    tags: str = "",
    content_format: str = "",
    content_type: str = "",
    index_decision: str = "",
    caller_org_id: str = "",
    caller_tenant_ids: list[str] | None = None,
) -> str:
    """Build a Milvus filter expression from metadata signals + mandatory scope.

    Combines optional language, artifact_kind, repo_path, tags,
    content_format, content_type, index_decision with domain filter using AND.
    Always prepends the three-tier visibility scope predicate when the schema
    supports it (fail-closed: no org → global only).
    Silently skips fields that are missing from the collection schema.
    """
    available = _catalog_fields
    parts: list[str] = []

    scope_expr = build_scope_filter(
        caller_org_id=caller_org_id,
        caller_tenant_ids=caller_tenant_ids,
    )
    if scope_expr:
        parts.append(scope_expr)

    if domain_filter:
        parts.append(f"({domain_filter})")
    if language and ("language" in available or not available):
        safe = language.replace('"', "")[:32]
        parts.append(f'language == "{safe}"')
    if artifact_kind and ("artifact_kind" in available or not available):
        safe = artifact_kind.replace('"', "")[:32]
        parts.append(f'artifact_kind == "{safe}"')
    if repo_path and ("repo_path" in available or not available):
        safe = repo_path.replace('"', "")[:256]
        parts.append(f'repo_path == "{safe}"')
    if tags and ("tags" in available or not available):
        safe = tags.replace('"', "").replace("'", "")[:64]
        parts.append(f'tags like "%{safe}%"')
    if content_format and ("content_format" in available or not available):
        safe = content_format.replace('"', "")[:32]
        parts.append(f'content_format == "{safe}"')
    if content_type and ("content_type" in available or not available):
        safe = content_type.replace('"', "")[:64]
        parts.append(f'content_type == "{safe}"')
    if index_decision and ("index_decision" in available or not available):
        safe = index_decision.replace('"', "")[:16]
        parts.append(f'index_decision == "{safe}"')
    return " and ".join(parts)


def select_collections_for_task(
    task_type: str,
    target_language: str,
    task_description: str = "",
    platform_context: str | None = None,
    active_domain_refs: list[str] | None = None,
) -> tuple[list[str], str]:
    """Return (collections, domain_filter). Taxonomy-aligned: active_domain_refs → Milvus filter.

    Indexers tag chunks with domain= taxonomy IDs (e.g. athletics_running, music_piano).
    When active_domain_refs present, filter to those domains for targeted retrieval.
    """
    _ensure_synesis_catalog()
    domain_filter = ""
    if active_domain_refs:
        refs = [str(r).strip() for r in active_domain_refs if r and str(r).strip()]
        if refs:
            escaped = [f'"{r}"' for r in refs[:10]]
            domain_filter = f"domain in [{','.join(escaped)}]"
    return [SYNESIS_CATALOG], domain_filter


# ---------------------------------------------------------------------------
# Vector search (Milvus)
# ---------------------------------------------------------------------------

_NOT_LOADED = "collection not loaded"


def _ensure_collection_loaded(client, collection_name: str) -> bool:
    """Load collection if not loaded. Returns True if searchable."""
    try:
        client.load_collection(collection_name=collection_name)
        return True
    except Exception as e:
        logger.debug("load_collection_failed", extra={"collection_name": collection_name, "error": str(e)[:200]})
        return False


async def _vector_search(
    query: str,
    collection: str,
    top_k: int,
    filter_expr: str = "",
) -> list[dict[str, Any]]:
    """Semantic vector search via Milvus. filter_expr: taxonomy-aligned domain filter (e.g. domain in ["athletics_running"])."""
    from pymilvus.exceptions import MilvusException

    client = _try_create_milvus_client()
    if client is None:
        return []

    try:
        collections = client.list_collections()
    except Exception as e:
        logger.warning("vector_search_list_collections_failed", extra={"error": str(e)[:200]})
        return []
    if collection not in collections:
        logger.warning("vector_search_collection_not_found", extra={"collection": collection, "available": collections})
        return []

    query_vector = await _embed_text(query)
    search_params = {
        "collection_name": collection,
        "data": [query_vector],
        "limit": top_k,
        "output_fields": _safe_output_fields(),
        "search_params": {"metric_type": "COSINE", "params": {"ef": max(128, top_k)}},
    }
    if filter_expr:
        search_params["filter"] = filter_expr

    try:
        results = client.search(**search_params)
    except MilvusException as e:
        if _NOT_LOADED in str(e).lower():
            if _ensure_collection_loaded(client, collection):
                try:
                    results = client.search(**search_params)
                except Exception as retry_e:
                    logger.warning(
                        "vector_search_retry_failed", extra={"collection": collection, "error": str(retry_e)[:200]}
                    )
                    return []
            else:
                return []
        else:
            logger.warning("vector_search_milvus_failed", extra={"collection": collection, "error": str(e)[:200]})
            return []
    except Exception as e:
        logger.warning("vector_search_failed", extra={"collection": collection, "error": str(e)[:200]})
        return []

    formatted = []
    for hits in results:
        for hit in hits:
            score = hit.get("distance", 0.0)
            if score < settings.rag_score_threshold:
                continue
            entity = hit.get("entity", {})
            formatted.append(
                {
                    "text": entity.get("text", ""),
                    "source": entity.get("document_name") or entity.get("source_url", "unknown"),
                    "vector_score": float(score),
                    "origin_type": entity.get("origin_type", ""),
                    "authority": entity.get("authority", ""),
                    "domain": entity.get("domain", ""),
                    "source_url": entity.get("source_url", ""),
                    "heading_path": entity.get("heading_path", ""),
                    "context_prefix": entity.get("context_prefix", ""),
                    "chunk_summary": entity.get("chunk_summary", ""),
                    "document_name": entity.get("document_name", ""),
                    "handler": entity.get("handler", ""),
                    "source_type": entity.get("source_type", ""),
                    "language": entity.get("language", ""),
                    "artifact_kind": entity.get("artifact_kind", ""),
                    "repo_path": entity.get("repo_path", ""),
                    "module_path": entity.get("module_path", ""),
                    "symbol_name": entity.get("symbol_name", ""),
                }
            )

    return formatted


# ---------------------------------------------------------------------------
# Milvus native hybrid search (dense + sparse BM25 via RRFRanker)
# ---------------------------------------------------------------------------

_OUTPUT_FIELDS = [
    "text",
    "chunk_id",
    "document_name",
    "origin_type",
    "authority",
    "domain",
    "source_url",
    "heading_path",
    "context_prefix",
    "chunk_summary",
    "handler",
    "source_type",
    "language",
    "artifact_kind",
    "repo_path",
    "module_path",
    "symbol_name",
    "content_type",
    "quality_score",
    "technical_depth",
    "domain_relevance",
    "index_decision",
    "keywords",
    "entities_json",
    "enrichment_profile",
]

_V8_FIELDS = {"language", "artifact_kind", "repo_path", "module_path", "symbol_name"}


def _safe_output_fields() -> list[str]:
    """Return output fields limited to those that actually exist in the collection.

    If _catalog_fields hasn't been populated yet (startup race), returns the
    full list and lets Milvus error handling deal with it.
    """
    if not _catalog_fields:
        return _OUTPUT_FIELDS
    return [f for f in _OUTPUT_FIELDS if f in _catalog_fields]


async def _hybrid_search(
    query: str,
    collection: str,
    top_k: int,
    filter_expr: str = "",
) -> list[dict[str, Any]]:
    """Server-side hybrid search: dense (COSINE) + sparse (BM25), merged by RRFRanker."""
    from pymilvus import AnnSearchRequest, RRFRanker

    query_vector = await _embed_text(query)
    dense_req = AnnSearchRequest(
        data=[query_vector],
        anns_field="embedding",
        param={"metric_type": "COSINE", "params": {"ef": max(128, top_k)}},
        limit=top_k,
        expr=filter_expr or None,
    )
    sparse_req = AnnSearchRequest(
        data=[query],
        anns_field="sparse_text",
        param={"metric_type": "BM25"},
        limit=top_k,
        expr=filter_expr or None,
    )

    try:
        client = await _acquire_milvus_client()
    except Exception as e:
        logger.warning(
            "milvus_acquire_failed",
            extra={"collection": collection, "error": str(e)[:200]},
        )
        return []

    last_err: BaseException | None = None
    discard = False
    results = None
    try:
        for attempt in range(2):
            try:
                results = await asyncio.to_thread(
                    client.hybrid_search,
                    collection_name=collection,
                    reqs=[dense_req, sparse_req],
                    ranker=RRFRanker(k=settings.rag_rrf_k),
                    limit=top_k,
                    output_fields=_safe_output_fields(),
                )
                break
            except Exception as e:
                last_err = e
                if _is_connection_dead_error(e) and attempt == 0:
                    _evict_dead_alias(client)
                    client = _try_create_milvus_client()
                    if client is None:
                        discard = True
                        break
                    logger.info("milvus_reconnect_retry", extra={"collection": collection, "attempt": 1})
                    continue
                logger.warning(
                    "milvus_hybrid_search_failed",
                    extra={"collection": collection, "error": str(e)[:200]},
                )
                return []
        else:
            if last_err is not None:
                logger.warning(
                    "milvus_hybrid_search_failed_after_retry",
                    extra={"collection": collection, "error": str(last_err)[:200]},
                )
            return []
    finally:
        if not discard:
            await _release_milvus_client(client)

    if discard or results is None:
        return []

    formatted: list[dict[str, Any]] = []
    for hit in results[0] if results else []:
        entity = hit.entity if hasattr(hit, "entity") else hit.get("entity", {})
        if isinstance(entity, dict):
            _get = entity.get
        else:

            def _get(k: str, d: str = "", _e: Any = entity) -> Any:
                return getattr(_e, k, d)

        formatted.append(
            {
                "text": _get("text", ""),
                "source": _get("document_name", "") or _get("source_url", "unknown"),
                "vector_score": 0.0,
                "bm25_score": 0.0,
                "rrf_score": float(hit.distance) if hasattr(hit, "distance") else float(hit.get("distance", 0.0)),
                "retrieval_source": "hybrid",
                "origin_type": _get("origin_type", ""),
                "authority": _get("authority", ""),
                "domain": _get("domain", ""),
                "source_url": _get("source_url", ""),
                "heading_path": _get("heading_path", ""),
                "context_prefix": _get("context_prefix", ""),
                "chunk_summary": _get("chunk_summary", ""),
                "document_name": _get("document_name", ""),
                "handler": _get("handler", ""),
                "source_type": _get("source_type", ""),
            }
        )

    return formatted


def _format_hybrid_hits(results) -> list[dict[str, Any]]:
    """Shared hit formatter for hybrid search results."""
    formatted: list[dict[str, Any]] = []
    for hit in results[0] if results else []:
        entity = hit.entity if hasattr(hit, "entity") else hit.get("entity", {})
        if isinstance(entity, dict):
            _get = entity.get
        else:

            def _get(k: str, d: str = "", _e: Any = entity) -> Any:
                return getattr(_e, k, d)

        formatted.append(
            {
                "text": _get("text", ""),
                "source": _get("document_name", "") or _get("source_url", "unknown"),
                "vector_score": 0.0,
                "bm25_score": 0.0,
                "rrf_score": float(hit.distance) if hasattr(hit, "distance") else float(hit.get("distance", 0.0)),
                "retrieval_source": "hybrid",
                "origin_type": _get("origin_type", ""),
                "authority": _get("authority", ""),
                "domain": _get("domain", ""),
                "source_url": _get("source_url", ""),
                "heading_path": _get("heading_path", ""),
                "context_prefix": _get("context_prefix", ""),
                "chunk_summary": _get("chunk_summary", ""),
                "document_name": _get("document_name", ""),
                "handler": _get("handler", ""),
                "source_type": _get("source_type", ""),
            }
        )
    return formatted


async def _hybrid_search_with_vector(
    query_vector: list[float],
    query_text: str,
    collection: str,
    top_k: int,
    filter_expr: str = "",
) -> list[dict[str, Any]]:
    """Hybrid search using a pre-computed dense vector (avoids redundant embed call)."""
    from pymilvus import AnnSearchRequest, RRFRanker

    dense_req = AnnSearchRequest(
        data=[query_vector],
        anns_field="embedding",
        param={"metric_type": "COSINE", "params": {"ef": max(128, top_k)}},
        limit=top_k,
        expr=filter_expr or None,
    )
    sparse_req = AnnSearchRequest(
        data=[query_text],
        anns_field="sparse_text",
        param={"metric_type": "BM25"},
        limit=top_k,
        expr=filter_expr or None,
    )

    try:
        client = await _acquire_milvus_client()
    except Exception as e:
        logger.warning("milvus_acquire_failed", extra={"collection": collection, "error": str(e)[:200]})
        return []

    last_err: BaseException | None = None
    discard = False
    results = None
    try:
        for attempt in range(2):
            try:
                results = await asyncio.to_thread(
                    client.hybrid_search,
                    collection_name=collection,
                    reqs=[dense_req, sparse_req],
                    ranker=RRFRanker(k=settings.rag_rrf_k),
                    limit=top_k,
                    output_fields=_safe_output_fields(),
                )
                break
            except Exception as e:
                last_err = e
                if _is_connection_dead_error(e) and attempt == 0:
                    _evict_dead_alias(client)
                    client = _try_create_milvus_client()
                    if client is None:
                        discard = True
                        break
                    logger.info("milvus_reconnect_retry", extra={"collection": collection, "attempt": 1})
                    continue
                logger.warning("milvus_hybrid_search_failed", extra={"collection": collection, "error": str(e)[:200]})
                return []
        else:
            if last_err is not None:
                logger.warning(
                    "milvus_hybrid_search_failed_after_retry",
                    extra={"collection": collection, "error": str(last_err)[:200]},
                )
            return []
    finally:
        if not discard:
            await _release_milvus_client(client)

    if discard or results is None:
        return []

    return _format_hybrid_hits(results)


def _rrf_merge_dicts(
    per_query_results: list[list[dict[str, Any]]],
    k: int = 60,
) -> list[dict[str, Any]]:
    """RRF merge across multiple raw dict result lists."""
    scores: dict[str, float] = {}
    best: dict[str, dict[str, Any]] = {}
    for results in per_query_results:
        if not isinstance(results, list):
            continue
        for rank, r in enumerate(results):
            key = r.get("source_url") or r.get("document_name") or f"text:{r.get('text', '')[:80]}"
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank + 1)
            if key not in best or r.get("rrf_score", 0.0) > best[key].get("rrf_score", 0.0):
                best[key] = r
    sorted_keys = sorted(scores, key=lambda x: scores[x], reverse=True)
    merged: list[dict[str, Any]] = []
    for key in sorted_keys:
        doc = best[key].copy()
        doc["rrf_score"] = scores[key]
        merged.append(doc)
    return merged


async def retrieve_multi_query_fused(
    queries: list[str],
    collection: str = SYNESIS_CATALOG,
    per_query_limit: int = 25,
    final_top_k: int = 50,
    reranker: str | None = None,
    domain_filter: str = "",
) -> list[RetrievalResult]:
    """Consolidated multi-query retrieval: batch embed, parallel search, RRF merge, single rerank.

    Designed for the consolidated router -- replaces N independent retrieve_context
    calls with one fast fused pass.
    """
    if reranker is None:
        reranker = settings.rag_reranker

    _ensure_synesis_catalog()
    _ensure_metrics()

    vectors = await _batch_embed_texts(queries)

    search_tasks = [
        _hybrid_search_with_vector(vec, q, collection, per_query_limit, filter_expr=domain_filter)
        for vec, q in zip(vectors, queries)
    ]
    raw_results = await asyncio.gather(*search_tasks, return_exceptions=True)
    valid_results = [r for r in raw_results if isinstance(r, list)]

    if not valid_results:
        logger.warning("fused_retrieval_all_failed", extra={"queries": len(queries)})
        return []

    merged = _rrf_merge_dicts(valid_results)

    if reranker != "none" and merged:
        primary_query = " ".join(q[:100] for q in queries[:2])
        merged = await _rerank(primary_query, merged, reranker, final_top_k)
    else:
        merged.sort(key=lambda d: d.get("rrf_score", 0.0), reverse=True)
        merged = merged[:final_top_k]

    _AUTHORITY_BOOST = {
        "canonical": 1.5,
        "vetted": 1.3,
        "community": 1.0,
        "external": 0.7,
        "": 1.0,
    }
    for doc in merged:
        boost = _AUTHORITY_BOOST.get(doc.get("authority", ""), 1.0)
        score_key = "rerank_score" if doc.get("rerank_score", 0.0) > 0 else "rrf_score"
        doc[score_key] = doc.get(score_key, 0.0) * boost
    merged.sort(key=lambda d: d.get("rerank_score", 0.0) or d.get("rrf_score", 0.0), reverse=True)

    score_min = getattr(settings, "rag_rerank_score_min", 0.0)
    if score_min > 0 and reranker != "none":
        pre_floor = len(merged)
        merged = [d for d in merged if (d.get("rerank_score", 0.0) or d.get("rrf_score", 0.0)) >= score_min]
        dropped = pre_floor - len(merged)
        if dropped:
            logger.info(
                "fused_rerank_score_floor", extra={"threshold": score_min, "dropped": dropped, "kept": len(merged)}
            )

    results = [
        RetrievalResult(
            text=doc["text"],
            source=doc.get("source", "unknown"),
            collection=collection,
            retrieval_source=doc.get("retrieval_source", "hybrid"),
            vector_score=doc.get("vector_score", 0.0),
            bm25_score=doc.get("bm25_score", 0.0),
            rrf_score=doc.get("rrf_score", 0.0),
            rerank_score=doc.get("rerank_score", 0.0),
            origin_type=doc.get("origin_type", ""),
            authority=doc.get("authority", ""),
            domain=doc.get("domain", ""),
            source_url=doc.get("source_url", ""),
            heading_path=doc.get("heading_path", ""),
            context_prefix=doc.get("context_prefix", ""),
            chunk_summary=doc.get("chunk_summary", ""),
            document_name=doc.get("document_name", ""),
            handler=doc.get("handler", ""),
            source_type=doc.get("source_type", ""),
            language=doc.get("language", ""),
            artifact_kind=doc.get("artifact_kind", ""),
            repo_path=doc.get("repo_path", ""),
            module_path=doc.get("module_path", ""),
            symbol_name=doc.get("symbol_name", ""),
        )
        for doc in merged
    ]

    authority_dist: dict[str, int] = {}
    for r in results:
        authority_dist[r.authority or "unknown"] = authority_dist.get(r.authority or "unknown", 0) + 1

    logger.info(
        "fused_retrieval",
        extra={
            "queries": len(queries),
            "per_query_limit": per_query_limit,
            "reranker": reranker,
            "results_returned": len(results),
            "top_score": results[0].rerank_score or results[0].rrf_score if results else 0.0,
            "authority_distribution": authority_dist,
        },
    )

    return results


async def _sparse_search(
    query: str,
    collection: str,
    top_k: int,
    filter_expr: str = "",
) -> list[dict[str, Any]]:
    """BM25-only search via Milvus sparse_text field."""
    search_kwargs: dict[str, Any] = {
        "collection_name": collection,
        "data": [query],
        "anns_field": "sparse_text",
        "limit": top_k,
        "output_fields": _safe_output_fields(),
        "search_params": {"metric_type": "BM25"},
    }
    if filter_expr:
        search_kwargs["filter"] = filter_expr

    try:
        client = await _acquire_milvus_client()
    except Exception as e:
        logger.warning(
            "milvus_acquire_failed",
            extra={"collection": collection, "error": str(e)[:200]},
        )
        return []

    last_err: BaseException | None = None
    results = None
    discard = False
    try:
        for attempt in range(2):
            try:
                results = await asyncio.to_thread(client.search, **search_kwargs)
                break
            except Exception as e:
                last_err = e
                if _is_connection_dead_error(e) and attempt == 0:
                    _evict_dead_alias(client)
                    client = _try_create_milvus_client()
                    if client is None:
                        discard = True
                        break
                    logger.info("milvus_reconnect_retry", extra={"collection": collection, "attempt": 1})
                    continue
                logger.warning(
                    "milvus_sparse_search_failed",
                    extra={"collection": collection, "error": str(e)[:200]},
                )
                return []
        if results is None and last_err is not None:
            logger.warning(
                "milvus_sparse_search_failed_after_retry",
                extra={"collection": collection, "error": str(last_err)[:200]},
            )
            return []
    finally:
        if not discard:
            await _release_milvus_client(client)

    if discard:
        return []

    formatted: list[dict[str, Any]] = []
    for hits in results or []:
        for hit in hits:
            entity = hit.get("entity", {})
            formatted.append(
                {
                    "text": entity.get("text", ""),
                    "source": entity.get("document_name") or entity.get("source_url", "unknown"),
                    "bm25_score": float(hit.get("distance", 0.0)),
                    "vector_score": 0.0,
                    "rrf_score": float(hit.get("distance", 0.0)),
                    "retrieval_source": "bm25",
                    "origin_type": entity.get("origin_type", ""),
                    "authority": entity.get("authority", ""),
                    "domain": entity.get("domain", ""),
                    "source_url": entity.get("source_url", ""),
                    "heading_path": entity.get("heading_path", ""),
                    "context_prefix": entity.get("context_prefix", ""),
                    "chunk_summary": entity.get("chunk_summary", ""),
                    "document_name": entity.get("document_name", ""),
                    "handler": entity.get("handler", ""),
                    "source_type": entity.get("source_type", ""),
                }
            )

    return formatted


# ---------------------------------------------------------------------------
# Cross-encoder re-ranking
# ---------------------------------------------------------------------------

_flashrank_ranker = None
_flashrank_lock = threading.Lock()


def _get_flashrank_ranker():
    global _flashrank_ranker
    if _flashrank_ranker is None:
        with _flashrank_lock:
            if _flashrank_ranker is None:
                from flashrank import Ranker

                _flashrank_ranker = Ranker(model_name=settings.rag_reranker_model)
    return _flashrank_ranker


async def _rerank_flashrank(
    query: str,
    results: list[dict[str, Any]],
    top_k: int,
) -> list[dict[str, Any]]:
    """Re-rank using FlashRank cross-encoder (inline, ~4ms)."""
    if not results:
        return results

    # Build passages using context_prefix + text (matches embedding input)
    passages = []
    valid_indices = []
    for i, r in enumerate(results):
        text = r.get("text") if isinstance(r, dict) else None
        if text and isinstance(text, str) and text.strip():
            prefix = r.get("context_prefix", "") if isinstance(r, dict) else ""
            rerank_text = f"{prefix} {text}".strip() if prefix else text
            passages.append({"id": i, "text": rerank_text[:8000]})
            valid_indices.append(i)

    if not passages:
        return results[:top_k]

    try:
        from flashrank import RerankRequest

        ranker = _get_flashrank_ranker()
        request = RerankRequest(query=query, passages=passages)

        start = time.monotonic()
        reranked = await asyncio.to_thread(ranker.rerank, request)
        elapsed = time.monotonic() - start

        _ensure_metrics()
        if _reranker_latency_histogram:
            _reranker_latency_histogram.labels(reranker="flashrank").observe(elapsed)

        # FlashRank returns list of {"id": ..., "score": ...}; handle format variations
        id_to_score: dict[int, float] = {}
        for r in reranked if isinstance(reranked, list) else []:
            rid = r.get("id") if isinstance(r, dict) else None
            score = r.get("score") if isinstance(r, dict) else 0.0
            if rid is not None:
                id_to_score[int(rid)] = float(score) if score is not None else 0.0

        for i, result in enumerate(results):
            result["rerank_score"] = id_to_score.get(i, 0.0)

        results.sort(key=lambda r: r["rerank_score"], reverse=True)
        return results[:top_k]
    except Exception as e:
        logger.warning("flashrank_rerank_failed", extra={"error": str(e)[:200]})
        return results[:top_k]


async def _rerank_bge(
    query: str,
    results: list[dict[str, Any]],
    top_k: int,
) -> list[dict[str, Any]]:
    """Re-rank via external BGE reranker service."""
    if not results or not settings.rag_bge_reranker_url:
        return results[:top_k]

    base = ensure_url_protocol(settings.rag_bge_reranker_url)
    client = await _get_client()
    try:
        start = time.monotonic()
        response = await client.post(
            f"{base.rstrip('/')}/rerank",
            json={
                "query": query,
                "passages": [r["text"] for r in results],
            },
            timeout=10.0,
        )
        response.raise_for_status()
        elapsed = time.monotonic() - start

        _ensure_metrics()
        if _reranker_latency_histogram:
            _reranker_latency_histogram.labels(reranker="bge").observe(elapsed)

        scores = response.json().get("scores", [])
        for i, result in enumerate(results):
            result["rerank_score"] = scores[i] if i < len(scores) else 0.0

        results.sort(key=lambda r: r["rerank_score"], reverse=True)
        return results[:top_k]

    except Exception as e:
        logger.warning("bge_rerank_failed", extra={"error": str(e)[:200]})
        return results[:top_k]


async def _rerank(
    query: str,
    results: list[dict[str, Any]],
    reranker: str,
    top_k: int,
) -> list[dict[str, Any]]:
    if reranker == "flashrank":
        return await _rerank_flashrank(query, results, top_k)
    elif reranker == "bge":
        return await _rerank_bge(query, results, top_k)
    return results[:top_k]


# ---------------------------------------------------------------------------
# Main retrieval entrypoint
# ---------------------------------------------------------------------------


async def retrieve_context(
    query: str,
    collection: str = "bash_v1",
    top_k: int | None = None,
    strategy: str | None = None,
    reranker: str | None = None,
    collections: list[str] | None = None,
    domain_filter: str = "",
) -> list[RetrievalResult]:
    """Retrieve relevant document chunks using the configured strategy.

    When ``collections`` is provided, queries each collection separately,
    merges all results, and re-ranks the combined set.  Otherwise queries
    the single ``collection``.

    Returns a list of RetrievalResult with full provenance metadata.
    Falls back gracefully on any error (degraded mode).
    """
    if top_k is None:
        top_k = settings.rag_top_k
    if strategy is None:
        strategy = settings.rag_retrieval_strategy
    if reranker is None:
        reranker = settings.rag_reranker

    target_collections = collections if collections else [collection]

    _ensure_metrics()

    all_merged: list[dict[str, Any]] = []
    fallback_to_bm25 = False

    for coll in target_collections:
        try:
            coll_results, coll_fallback = await _retrieve_single_collection(
                query,
                coll,
                top_k,
                strategy,
                domain_filter=domain_filter,
            )
            for r in coll_results:
                r["_collection"] = coll
            all_merged.extend(coll_results)
            if coll_fallback:
                fallback_to_bm25 = True
        except Exception as e:
            logger.warning("rag_retrieval_failed", extra={"collection": coll, "error": str(e)[:200]})

    if reranker != "none" and all_merged:
        all_merged = await _rerank(query, all_merged, reranker, top_k)
    else:
        all_merged.sort(key=lambda d: d.get("rrf_score", 0.0), reverse=True)
        all_merged = all_merged[:top_k]

    # Authority-weighted re-ranking (RA-RAG, arxiv 2410.22954):
    # Boost scores by source authority tier so higher-authority content
    # surfaces above lower-authority content at equal relevance.
    _AUTHORITY_BOOST = {
        "canonical": 1.5,
        "vetted": 1.3,
        "community": 1.0,
        "external": 0.7,
        "": 1.0,
    }
    for doc in all_merged:
        boost = _AUTHORITY_BOOST.get(doc.get("authority", ""), 1.0)
        score_key = "rerank_score" if doc.get("rerank_score", 0.0) > 0 else "rrf_score"
        doc[score_key] = doc.get(score_key, 0.0) * boost

    all_merged.sort(
        key=lambda d: d.get("rerank_score", 0.0) or d.get("rrf_score", 0.0),
        reverse=True,
    )

    score_min = getattr(settings, "rag_rerank_score_min", 0.0)
    if score_min > 0 and reranker != "none":
        pre_floor = len(all_merged)
        all_merged = [d for d in all_merged if (d.get("rerank_score", 0.0) or d.get("rrf_score", 0.0)) >= score_min]
        dropped = pre_floor - len(all_merged)
        if dropped:
            logger.info(
                "rerank_score_floor",
                extra={"threshold": score_min, "dropped": dropped, "kept": len(all_merged)},
            )

    if _retrieval_source_counter:
        for doc in all_merged:
            _retrieval_source_counter.labels(source=doc.get("retrieval_source", "unknown")).inc()

    results = [
        RetrievalResult(
            text=doc["text"],
            source=doc.get("source", "unknown"),
            collection=doc.get("_collection", ""),
            retrieval_source=doc.get("retrieval_source", "vector"),
            vector_score=doc.get("vector_score", 0.0),
            bm25_score=doc.get("bm25_score", 0.0),
            rrf_score=doc.get("rrf_score", 0.0),
            rerank_score=doc.get("rerank_score", 0.0),
            origin_type=doc.get("origin_type", ""),
            authority=doc.get("authority", ""),
            domain=doc.get("domain", ""),
            source_url=doc.get("source_url", ""),
            heading_path=doc.get("heading_path", ""),
            context_prefix=doc.get("context_prefix", ""),
            chunk_summary=doc.get("chunk_summary", ""),
            document_name=doc.get("document_name", ""),
            handler=doc.get("handler", ""),
            source_type=doc.get("source_type", ""),
        )
        for doc in all_merged
    ]

    effective_strategy = "bm25" if fallback_to_bm25 else strategy

    authority_dist: dict[str, int] = {}
    cited_count = 0
    for r in results:
        authority_dist[r.authority or "unknown"] = authority_dist.get(r.authority or "unknown", 0) + 1
        if r.source_url:
            cited_count += 1

    logger.info(
        "rag_retrieval",
        extra={
            "collections": target_collections,
            "strategy": effective_strategy,
            "reranker": reranker,
            "query_length": len(query),
            "results_returned": len(results),
            "fallback_to_bm25": fallback_to_bm25,
            "top_score": results[0].rerank_score or results[0].rrf_score if results else 0.0,
            "authority_distribution": authority_dist,
            "citable_chunks": cited_count,
        },
    )
    logger.debug(
        "rag_provenance_detail",
        extra={
            "chunks": [
                {
                    "source": r.source[:60],
                    "authority": r.authority,
                    "origin_type": r.origin_type,
                    "has_url": bool(r.source_url),
                }
                for r in results[:10]
            ],
        },
    )

    return results


async def _retrieve_single_collection(
    query: str,
    collection: str,
    top_k: int,
    strategy: str,
    domain_filter: str = "",
) -> tuple[list[dict[str, Any]], bool]:
    """Retrieve from a single collection using Milvus native search.

    strategy="hybrid" uses Milvus hybrid_search (dense + sparse BM25 + RRFRanker).
    strategy="vector" uses dense-only cosine search.
    strategy="bm25"   uses sparse-only BM25 search.

    On hybrid failure, falls back to sparse BM25-only.
    """
    fetch_k = top_k * 2
    fallback_to_bm25 = False

    if strategy == "hybrid":
        try:
            merged = await _hybrid_search(query, collection, fetch_k, filter_expr=domain_filter)
            return merged, False
        except Exception as e:
            logger.warning("hybrid_search_failed", extra={"collection": collection, "error": str(e)[:200]})
            fallback_to_bm25 = True
            if _bm25_fallback_counter:
                _bm25_fallback_counter.inc()

    if strategy == "vector" and not fallback_to_bm25:
        vector_results = await _vector_search(query, collection, fetch_k, filter_expr=domain_filter)
        merged = [
            {**r, "retrieval_source": "vector", "bm25_score": 0.0, "rrf_score": r.get("vector_score", 0.0)}
            for r in vector_results
        ]
        return merged, False

    # strategy="bm25" or fallback
    sparse_results = await _sparse_search(query, collection, fetch_k, filter_expr=domain_filter)
    return sparse_results, fallback_to_bm25
