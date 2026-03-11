"""Hybrid RAG retrieval client with cross-encoder re-ranking.

Supports three retrieval strategies:
  - "vector": Milvus cosine similarity (semantic)
  - "bm25": In-memory BM25Okapi (keyword/exact match)
  - "hybrid": Both retrievers merged via Reciprocal Rank Fusion

Cross-encoder re-rankers (applied after retrieval):
  - "flashrank": Ultra-fast inline (~4ms), no PyTorch needed
  - "bge": High-accuracy via external BGE service
  - "none": Skip re-ranking

Fallback: If Milvus/embedder is unreachable, hybrid and vector
strategies auto-degrade to BM25-only from cached chunks.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx
from rank_bm25 import BM25Okapi

from .config import settings
from .state import RetrievalResult
from .url_utils import ensure_url_protocol

logger = logging.getLogger("synesis.rag")

# Unified catalog (synesis_catalog) — single collection, one BM25 index.
# Schema must match base/rag/indexer/app/schema.py for indexer compatibility.
SYNESIS_CATALOG = "synesis_catalog"

# ---------------------------------------------------------------------------
# Lightweight suffix-stripping stemmer (no NLTK dependency)
# Handles common English inflections: architecture/architectural,
# design/designing/designed, etc. Applied to BM25 corpus and query tokens.
# ---------------------------------------------------------------------------
_STEM_SUFFIXES = (
    "ational",
    "izing",
    "ation",
    "ness",
    "ment",
    "ible",
    "able",
    "ical",
    "ful",
    "ous",
    "ive",
    "ing",
    "ies",
    "ed",
    "ly",
    "al",
    "er",
    "es",
    "s",
)


def _stem(word: str) -> str:
    """Strip common English suffixes, preserving a root of >= 3 chars."""
    for suffix in _STEM_SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[: -len(suffix)]
    return word


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


# ---------------------------------------------------------------------------
# BM25 In-Memory Index with Milvus chunk cache
# ---------------------------------------------------------------------------


@dataclass
class _CachedChunk:
    text: str
    source: str
    chunk_id: str
    origin_type: str = ""
    authority: str = ""
    domain: str = ""
    source_url: str = ""
    heading_path: str = ""
    context_prefix: str = ""
    chunk_summary: str = ""
    document_name: str = ""
    handler: str = ""
    source_type: str = ""
    keywords: str = ""
    tags: str = ""


_BM25_OUTPUT_FIELDS = [
    "chunk_id",
    "text",
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
    "keywords",
    "tags",
]

_MILVUS_TIMEOUT = 10


class BM25Index:
    """Thread-safe in-memory BM25 index built from Milvus chunks.

    Loads all chunks from a Milvus collection on first access,
    then refreshes on a configurable interval. If Milvus is down,
    serves queries from the stale cache.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._refresh_locks: dict[str, threading.Lock] = {}
        self._indices: dict[str, BM25Okapi] = {}
        self._chunks: dict[str, list[_CachedChunk]] = {}
        self._tokenized: dict[str, list[list[str]]] = {}
        self._last_refresh: dict[str, float] = {}

    def _tokenize(self, text: str) -> list[str]:
        return [_stem(w) for w in text.lower().split()]

    @staticmethod
    def _enriched_text(chunk: _CachedChunk) -> str:
        """Build enriched BM25 corpus text from all searchable metadata.

        Includes heading_path, chunk_summary, document_name, keywords,
        tags, and the full text for maximum recall.
        """
        parts = []
        if chunk.heading_path:
            parts.append(chunk.heading_path)
        if chunk.chunk_summary:
            parts.append(chunk.chunk_summary)
        if chunk.document_name:
            parts.append(chunk.document_name)
        if chunk.keywords:
            parts.append(chunk.keywords)
        if chunk.tags:
            parts.append(chunk.tags)
        parts.append(chunk.text)
        return " ".join(parts)

    def _needs_refresh(self, collection: str) -> bool:
        last = self._last_refresh.get(collection, 0.0)
        return (time.time() - last) > settings.rag_bm25_refresh_interval_seconds

    def refresh_from_milvus(self, collection: str) -> None:
        """Synchronously fetch all chunks from Milvus and rebuild BM25 index.

        Uses query_iterator to avoid the Milvus 16,384-entity per-segment
        query limit. A per-collection mutex prevents concurrent scans, and
        failures set a 60s cooldown to avoid retry storms.
        """
        refresh_lock = self._refresh_locks.setdefault(collection, threading.Lock())
        if not refresh_lock.acquire(blocking=False):
            logger.debug("bm25_refresh_already_running", extra={"collection": collection})
            return
        try:
            self._do_refresh(collection)
        except Exception as e:
            logger.warning(
                "bm25_refresh_failed",
                extra={"collection": collection, "error": str(e)[:200]},
            )
            with self._lock:
                self._last_refresh[collection] = time.time() - (settings.rag_bm25_refresh_interval_seconds - 60)
        finally:
            refresh_lock.release()

    def _do_refresh(self, collection: str) -> None:
        from pymilvus import MilvusClient
        from pymilvus.exceptions import MilvusException

        client = MilvusClient(
            uri=f"http://{settings.milvus_host}:{settings.milvus_port}",
            timeout=_MILVUS_TIMEOUT,
        )

        if collection not in client.list_collections():
            logger.warning("bm25_collection_not_found", extra={"collection": collection})
            return

        all_chunks: list[_CachedChunk] = []

        try:
            iterator = client.query_iterator(
                collection_name=collection,
                filter="",
                output_fields=_BM25_OUTPUT_FIELDS,
                batch_size=100,
            )
            while True:
                batch = iterator.next()
                if not batch:
                    break
                for row in batch:
                    all_chunks.append(
                        _CachedChunk(
                            text=row.get("text", ""),
                            source=row.get("document_name") or row.get("source_url", "unknown"),
                            chunk_id=row.get("chunk_id", ""),
                            origin_type=row.get("origin_type", ""),
                            authority=row.get("authority", ""),
                            domain=row.get("domain", ""),
                            source_url=row.get("source_url", ""),
                            heading_path=row.get("heading_path", ""),
                            context_prefix=row.get("context_prefix", ""),
                            chunk_summary=row.get("chunk_summary", ""),
                            document_name=row.get("document_name", ""),
                            handler=row.get("handler", ""),
                            source_type=row.get("source_type", ""),
                            keywords=row.get("keywords", ""),
                            tags=row.get("tags", ""),
                        )
                    )
            iterator.close()
        except MilvusException as e:
            if "collection not loaded" in str(e).lower():
                _ensure_collection_loaded(client, collection)
                raise
            if "query_iterator" in str(e).lower() or isinstance(e, AttributeError):
                logger.warning("bm25_refresh_iterator_unavailable, falling back to query()")
                all_chunks = self._fallback_query_refresh(client, collection)
            else:
                raise
        except AttributeError:
            logger.warning("bm25_refresh_iterator_unavailable, falling back to query()")
            all_chunks = self._fallback_query_refresh(client, collection)

        if not all_chunks:
            logger.info("bm25_no_chunks", extra={"collection": collection})
            return

        tokenized = [self._tokenize(self._enriched_text(c)) for c in all_chunks]
        index = BM25Okapi(tokenized)

        with self._lock:
            self._chunks[collection] = all_chunks
            self._tokenized[collection] = tokenized
            self._indices[collection] = index
            self._last_refresh[collection] = time.time()

        logger.info(
            "bm25_index_refreshed",
            extra={"collection": collection, "chunk_count": len(all_chunks)},
        )

    @staticmethod
    def _fallback_query_refresh(client: Any, collection: str) -> list[_CachedChunk]:
        """Fallback for pymilvus < 2.6 where query_iterator may not exist."""
        all_chunks: list[_CachedChunk] = []
        batch_size = 100
        offset = 0
        while True:
            results = client.query(
                collection_name=collection,
                filter="",
                output_fields=_BM25_OUTPUT_FIELDS,
                limit=batch_size,
                offset=offset,
                timeout=_MILVUS_TIMEOUT,
            )
            if not results:
                break
            for row in results:
                all_chunks.append(
                    _CachedChunk(
                        text=row.get("text", ""),
                        source=row.get("document_name") or row.get("source_url", "unknown"),
                        chunk_id=row.get("chunk_id", ""),
                        origin_type=row.get("origin_type", ""),
                        authority=row.get("authority", ""),
                        domain=row.get("domain", ""),
                        source_url=row.get("source_url", ""),
                        heading_path=row.get("heading_path", ""),
                        context_prefix=row.get("context_prefix", ""),
                        chunk_summary=row.get("chunk_summary", ""),
                        document_name=row.get("document_name", ""),
                        handler=row.get("handler", ""),
                        source_type=row.get("source_type", ""),
                    )
                )
            if len(results) < batch_size:
                break
            offset += batch_size
        return all_chunks

    def ensure_loaded(self, collection: str) -> None:
        if self._needs_refresh(collection):
            self.refresh_from_milvus(collection)

    def search(self, query: str, collection: str, top_k: int = 10) -> list[dict[str, Any]]:
        with self._lock:
            index = self._indices.get(collection)
            chunks = self._chunks.get(collection, [])

        if index is None or not chunks:
            return []

        tokenized_query = self._tokenize(query)
        scores = index.get_scores(tokenized_query)

        scored = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)[:top_k]

        results = []
        for idx, score in scored:
            if score <= 0:
                continue
            chunk = chunks[idx]
            results.append(
                {
                    "text": chunk.text,
                    "source": chunk.source,
                    "bm25_score": float(score),
                    "origin_type": chunk.origin_type,
                    "authority": chunk.authority,
                    "domain": chunk.domain,
                    "source_url": chunk.source_url,
                    "heading_path": chunk.heading_path,
                    "context_prefix": chunk.context_prefix,
                    "chunk_summary": chunk.chunk_summary,
                    "document_name": chunk.document_name,
                    "handler": chunk.handler,
                    "source_type": chunk.source_type,
                }
            )

        return results


_bm25_index = BM25Index()


# ---------------------------------------------------------------------------
# Unified catalog bootstrap (schema must match base/rag/indexer/app/schema.py)
# ---------------------------------------------------------------------------

_catalog_ensured = False

# Must match EXPECTED_FIELDS in base/rag/indexer/app/schema.py (SCHEMA_VERSION=2).
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
        "embedding",
    }
)


def _validate_catalog_schema(client) -> bool:
    """Check if the existing collection has all expected fields."""
    try:
        desc = client.describe_collection(collection_name=SYNESIS_CATALOG)
        existing = {f.get("name", "") for f in desc.get("fields", [])}
        missing = _EXPECTED_FIELDS - existing
        if missing:
            logger.warning("synesis_catalog schema drift — missing fields: %s", missing)
            return False
        return True
    except Exception as e:
        logger.warning("Could not validate synesis_catalog schema: %s", e)
        return False


def _ensure_synesis_catalog() -> None:
    """Create synesis_catalog if missing; drop+recreate if schema is stale."""
    global _catalog_ensured
    if _catalog_ensured:
        return
    try:
        from pymilvus import CollectionSchema, DataType, FieldSchema, MilvusClient

        client = MilvusClient(uri=f"http://{settings.milvus_host}:{settings.milvus_port}", timeout=_MILVUS_TIMEOUT)

        if SYNESIS_CATALOG in client.list_collections():
            if _validate_catalog_schema(client):
                _catalog_ensured = True
                return
            logger.warning(
                "Dropping stale synesis_catalog — schema mismatch. Data will be re-indexed on next indexer run."
            )
            client.drop_collection(collection_name=SYNESIS_CATALOG)

        # Schema must match base/rag/indexer/app/schema.py exactly (SCHEMA_VERSION=2).
        schema = CollectionSchema(
            fields=[
                FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
                FieldSchema(name="doc_id", dtype=DataType.VARCHAR, max_length=128),
                FieldSchema(name="chunk_index", dtype=DataType.INT64),
                FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=8192),
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
                FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=384),
            ],
            description="Synesis unified RAG catalog v2",
            enable_dynamic_field=False,
        )
        client.create_collection(collection_name=SYNESIS_CATALOG, schema=schema)

        index_params = MilvusClient.prepare_index_params()
        index_params.add_index(
            field_name="embedding",
            index_type="HNSW",
            metric_type="COSINE",
            params={"M": 16, "efConstruction": 200},
        )
        client.create_index(collection_name=SYNESIS_CATALOG, index_params=index_params)
        client.load_collection(collection_name=SYNESIS_CATALOG)
        _catalog_ensured = True
        logger.info("Created unified catalog '%s' v2", SYNESIS_CATALOG)
    except Exception as e:
        logger.warning("ensure_synesis_catalog_failed", extra={"error": str(e)[:200]})


async def submit_user_knowledge(
    domain: str,
    content: str,
    source: str = "user_submitted",
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
        "embedding": embedding,
    }

    try:
        from pymilvus import MilvusClient

        client = MilvusClient(uri=f"http://{settings.milvus_host}:{settings.milvus_port}", timeout=_MILVUS_TIMEOUT)
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
            # Milvus expr: domain in ["a","b"] — taxonomy IDs must match catalog domain field
            escaped = [f'"{r}"' for r in refs[:10]]  # cap to avoid expr length limits
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
    from pymilvus import MilvusClient
    from pymilvus.exceptions import MilvusException

    client = MilvusClient(uri=f"http://{settings.milvus_host}:{settings.milvus_port}", timeout=_MILVUS_TIMEOUT)

    collections = client.list_collections()
    if collection not in collections:
        logger.warning("vector_search_collection_not_found", extra={"collection": collection, "available": collections})
        return []

    query_vector = await _embed_text(query)
    search_params = {
        "collection_name": collection,
        "data": [query_vector],
        "limit": top_k,
        "output_fields": [
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
        ],
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
            raise

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
                }
            )

    return formatted


# ---------------------------------------------------------------------------
# BM25 search (in-memory)
# ---------------------------------------------------------------------------


async def _bm25_search(
    query: str,
    collection: str,
    top_k: int,
) -> list[dict[str, Any]]:
    """Keyword search via in-memory BM25 index."""
    await asyncio.to_thread(_bm25_index.ensure_loaded, collection)
    return await asyncio.to_thread(_bm25_index.search, query, collection, top_k)


# ---------------------------------------------------------------------------
# Reciprocal Rank Fusion
# ---------------------------------------------------------------------------


def _reciprocal_rank_fusion(
    vector_results: list[dict[str, Any]],
    bm25_results: list[dict[str, Any]],
    k: int = 60,
) -> list[dict[str, Any]]:
    """Merge results from multiple retrievers using RRF.

    RRF score = sum(1 / (k + rank_i)) across retrievers.
    """
    _PROVENANCE_KEYS = (
        "origin_type",
        "authority",
        "domain",
        "source_url",
        "heading_path",
        "context_prefix",
        "chunk_summary",
        "document_name",
        "handler",
        "source_type",
    )

    doc_map: dict[str, dict[str, Any]] = {}

    for rank, doc in enumerate(vector_results):
        key = doc["text"][:200]
        if key not in doc_map:
            entry: dict[str, Any] = {
                "text": doc["text"],
                "source": doc.get("source", "unknown"),
                "vector_score": doc.get("vector_score", 0.0),
                "bm25_score": 0.0,
                "rrf_score": 0.0,
                "retrieval_source": "vector",
            }
            for pk in _PROVENANCE_KEYS:
                entry[pk] = doc.get(pk, "")
            doc_map[key] = entry
        doc_map[key]["rrf_score"] += 1.0 / (k + rank + 1)
        doc_map[key]["vector_score"] = doc.get("vector_score", 0.0)

    for rank, doc in enumerate(bm25_results):
        key = doc["text"][:200]
        if key not in doc_map:
            entry = {
                "text": doc["text"],
                "source": doc.get("source", "unknown"),
                "vector_score": 0.0,
                "bm25_score": doc.get("bm25_score", 0.0),
                "rrf_score": 0.0,
                "retrieval_source": "bm25",
            }
            for pk in _PROVENANCE_KEYS:
                entry[pk] = doc.get(pk, "")
            doc_map[key] = entry
        else:
            doc_map[key]["retrieval_source"] = "both"
        doc_map[key]["rrf_score"] += 1.0 / (k + rank + 1)
        doc_map[key]["bm25_score"] = doc.get("bm25_score", 0.0)

    merged = sorted(doc_map.values(), key=lambda d: d["rrf_score"], reverse=True)
    return merged


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
        reranked = ranker.rerank(request)
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
    """Retrieve from a single collection. domain_filter applied to vector search (taxonomy-aligned)."""
    fetch_k = top_k * 4
    vector_results: list[dict[str, Any]] = []
    bm25_results: list[dict[str, Any]] = []
    fallback_to_bm25 = False

    if strategy in ("hybrid", "vector"):
        try:
            vector_results = await _vector_search(query, collection, fetch_k, filter_expr=domain_filter)
        except Exception as e:
            logger.warning("vector_search_failed", extra={"collection": collection, "error": str(e)[:200]})
            if strategy == "hybrid":
                fallback_to_bm25 = True
                if _bm25_fallback_counter:
                    _bm25_fallback_counter.inc()
            else:
                raise

    if strategy in ("hybrid", "bm25") or fallback_to_bm25:
        bm25_results = await _bm25_search(query, collection, fetch_k)

    if strategy == "hybrid" or fallback_to_bm25:
        merged = _reciprocal_rank_fusion(vector_results, bm25_results, k=settings.rag_rrf_k)
    elif strategy == "vector":
        merged = [
            {**r, "retrieval_source": "vector", "bm25_score": 0.0, "rrf_score": r.get("vector_score", 0.0)}
            for r in vector_results
        ]
    else:
        merged = [
            {**r, "retrieval_source": "bm25", "vector_score": 0.0, "rrf_score": r.get("bm25_score", 0.0)}
            for r in bm25_results
        ]

    return merged, fallback_to_bm25
