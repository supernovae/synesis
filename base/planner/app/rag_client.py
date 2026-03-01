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

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx
from rank_bm25 import BM25Okapi

from .config import settings
from .url_utils import ensure_url_protocol
from .state import RetrievalResult

logger = logging.getLogger("synesis.rag")

# Unified catalog (synesis_catalog) — single collection, one BM25 index.
# Schema must match base/rag/catalog_schema.py for indexer compatibility.
SYNESIS_CATALOG = "synesis_catalog"

_http_client: httpx.AsyncClient | None = None

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
    except Exception:
        pass
    _metrics_registered = True


def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=30.0)
    return _http_client


# ---------------------------------------------------------------------------
# Embedding helper
# ---------------------------------------------------------------------------


async def _embed_text(text: str) -> list[float]:
    """Get embedding vector from the embedder service."""
    base = ensure_url_protocol(settings.embedder_url)
    client = _get_client()
    response = await client.post(
        f"{base.rstrip('/')}/embeddings",
        json={"input": text, "model": settings.embedder_model},
    )
    response.raise_for_status()
    data = response.json()
    return data["data"][0]["embedding"]


# ---------------------------------------------------------------------------
# BM25 In-Memory Index with Milvus chunk cache
# ---------------------------------------------------------------------------


@dataclass
class _CachedChunk:
    text: str
    source: str
    chunk_id: str


class BM25Index:
    """Thread-safe in-memory BM25 index built from Milvus chunks.

    Loads all chunks from a Milvus collection on first access,
    then refreshes on a configurable interval. If Milvus is down,
    serves queries from the stale cache.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._indices: dict[str, BM25Okapi] = {}
        self._chunks: dict[str, list[_CachedChunk]] = {}
        self._tokenized: dict[str, list[list[str]]] = {}
        self._last_refresh: dict[str, float] = {}

    def _tokenize(self, text: str) -> list[str]:
        return text.lower().split()

    def _needs_refresh(self, collection: str) -> bool:
        last = self._last_refresh.get(collection, 0.0)
        return (time.time() - last) > settings.rag_bm25_refresh_interval_seconds

    def refresh_from_milvus(self, collection: str) -> None:
        """Synchronously fetch all chunks from Milvus and rebuild BM25 index."""
        try:
            from pymilvus import MilvusClient
            from pymilvus.exceptions import MilvusException

            client = MilvusClient(uri=f"http://{settings.milvus_host}:{settings.milvus_port}")

            if collection not in client.list_collections():
                logger.warning(f"BM25 refresh: collection '{collection}' not found")
                return

            def _query_batch(offset: int):
                return client.query(
                    collection_name=collection,
                    filter="",
                    output_fields=["chunk_id", "text", "source"],
                    limit=1000,
                    offset=offset,
                )

            all_chunks: list[_CachedChunk] = []
            batch_size = 1000
            offset = 0

            while True:
                try:
                    results = _query_batch(offset)
                except MilvusException as e:
                    if "collection not loaded" in str(e).lower():
                        _ensure_collection_loaded(client, collection)
                        try:
                            results = _query_batch(offset)
                        except Exception as retry_e:
                            logger.warning(f"BM25 refresh failed for '{collection}' (collection unloadable): {retry_e}")
                            return
                    else:
                        raise
                if not results:
                    break
                for row in results:
                    all_chunks.append(
                        _CachedChunk(
                            text=row.get("text", ""),
                            source=row.get("source", "unknown"),
                            chunk_id=row.get("chunk_id", ""),
                        )
                    )
                if len(results) < batch_size:
                    break
                offset += batch_size

            if not all_chunks:
                logger.info(f"BM25 refresh: no chunks in '{collection}'")
                return

            tokenized = [self._tokenize(c.text) for c in all_chunks]
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

        except Exception as e:
            logger.warning(f"BM25 refresh failed for '{collection}' (using stale cache): {e}")

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
                }
            )

        return results


_bm25_index = BM25Index()


# ---------------------------------------------------------------------------
# Unified catalog bootstrap (schema must match base/rag/catalog_schema.py)
# ---------------------------------------------------------------------------

_catalog_ensured = False


def _ensure_synesis_catalog() -> None:
    """Create synesis_catalog if it does not exist. Idempotent."""
    global _catalog_ensured
    if _catalog_ensured:
        return
    try:
        from pymilvus import CollectionSchema, DataType, FieldSchema, MilvusClient

        client = MilvusClient(uri=f"http://{settings.milvus_host}:{settings.milvus_port}")
        if SYNESIS_CATALOG in client.list_collections():
            _catalog_ensured = True
            return

        schema = CollectionSchema(
            fields=[
                FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
                FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=8192),
                FieldSchema(name="source", dtype=DataType.VARCHAR, max_length=512),
                FieldSchema(name="language", dtype=DataType.VARCHAR, max_length=32),
                FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=384),
                FieldSchema(name="domain", dtype=DataType.VARCHAR, max_length=64),
                FieldSchema(name="expertise_level", dtype=DataType.VARCHAR, max_length=32),
                FieldSchema(name="indexer_source", dtype=DataType.VARCHAR, max_length=64),
                FieldSchema(name="section", dtype=DataType.VARCHAR, max_length=256),
                FieldSchema(name="document_name", dtype=DataType.VARCHAR, max_length=256),
                FieldSchema(name="tags", dtype=DataType.VARCHAR, max_length=512),
            ],
            description="Synesis unified RAG catalog",
        )
        client.create_collection(collection_name=SYNESIS_CATALOG, schema=schema)

        index_params = MilvusClient.prepare_index_params()
        index_params.add_index(
            field_name="embedding",
            index_type="IVF_FLAT",
            metric_type="COSINE",
            params={"nlist": 128},
        )
        client.create_index(collection_name=SYNESIS_CATALOG, index_params=index_params)
        client.load_collection(collection_name=SYNESIS_CATALOG)
        _catalog_ensured = True
        logger.info(f"Created unified catalog '{SYNESIS_CATALOG}'")
    except Exception as e:
        logger.warning(f"Could not ensure synesis_catalog: {e}")


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
        "text": content.strip()[:8192],
        "source": f"{source}:{domain}"[:512],
        "language": "general",
        "embedding": embedding,
        "domain": (domain or "generalist")[:64],
        "expertise_level": "",
        "indexer_source": "user_submitted",
        "section": "",
        "document_name": source[:256],
        "tags": "",
    }

    try:
        from pymilvus import MilvusClient

        client = MilvusClient(uri=f"http://{settings.milvus_host}:{settings.milvus_port}")
        client.upsert(collection_name=SYNESIS_CATALOG, data=[entity])
        logger.info("knowledge_submitted", extra={"chunk_id": chunk_id[:12], "domain": domain})
        return chunk_id
    except Exception as e:
        logger.warning(f"Failed to submit knowledge: {e}")
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
) -> list[str]:
    """Return synesis_catalog only. Metadata (domain, indexer_source) drives retrieval gravity."""
    _ensure_synesis_catalog()
    return [SYNESIS_CATALOG]


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
        logger.debug(f"Could not load collection '{collection_name}': {e}")
        return False


async def _vector_search(
    query: str,
    collection: str,
    top_k: int,
) -> list[dict[str, Any]]:
    """Semantic vector search via Milvus. Gracefully returns [] on missing/empty/unloaded collection."""
    from pymilvus import MilvusClient
    from pymilvus.exceptions import MilvusException

    client = MilvusClient(uri=f"http://{settings.milvus_host}:{settings.milvus_port}")

    collections = client.list_collections()
    if collection not in collections:
        logger.warning(f"Vector search: collection '{collection}' not found, available: {collections}")
        return []

    query_vector = await _embed_text(query)

    try:
        results = client.search(
            collection_name=collection,
            data=[query_vector],
            limit=top_k,
            output_fields=["text", "source", "chunk_id"],
        )
    except MilvusException as e:
        if _NOT_LOADED in str(e).lower():
            if _ensure_collection_loaded(client, collection):
                try:
                    results = client.search(
                        collection_name=collection,
                        data=[query_vector],
                        limit=top_k,
                        output_fields=["text", "source", "chunk_id"],
                    )
                except Exception as retry_e:
                    logger.warning(f"Vector search retry failed for '{collection}': {retry_e}")
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
                    "source": entity.get("source", "unknown"),
                    "vector_score": float(score),
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
    _bm25_index.ensure_loaded(collection)
    return _bm25_index.search(query, collection, top_k)


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
    doc_map: dict[str, dict[str, Any]] = {}

    for rank, doc in enumerate(vector_results):
        key = doc["text"][:200]
        if key not in doc_map:
            doc_map[key] = {
                "text": doc["text"],
                "source": doc.get("source", "unknown"),
                "vector_score": doc.get("vector_score", 0.0),
                "bm25_score": 0.0,
                "rrf_score": 0.0,
                "retrieval_source": "vector",
            }
        doc_map[key]["rrf_score"] += 1.0 / (k + rank + 1)
        doc_map[key]["vector_score"] = doc.get("vector_score", 0.0)

    for rank, doc in enumerate(bm25_results):
        key = doc["text"][:200]
        if key not in doc_map:
            doc_map[key] = {
                "text": doc["text"],
                "source": doc.get("source", "unknown"),
                "vector_score": 0.0,
                "bm25_score": doc.get("bm25_score", 0.0),
                "rrf_score": 0.0,
                "retrieval_source": "bm25",
            }
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

    # Build passages; skip entries without valid text (defensive)
    passages = []
    valid_indices = []
    for i, r in enumerate(results):
        text = r.get("text") if isinstance(r, dict) else None
        if text and isinstance(text, str) and text.strip():
            passages.append({"id": i, "text": text[:8000]})
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
        logger.warning(f"FlashRank rerank failed, using RRF order: {e}")
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
    client = _get_client()
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
        logger.warning(f"BGE re-ranking failed, falling back to RRF order: {e}")
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
            )
            for r in coll_results:
                r["_collection"] = coll
            all_merged.extend(coll_results)
            if coll_fallback:
                fallback_to_bm25 = True
        except Exception as e:
            logger.warning(f"RAG retrieval failed for collection '{coll}': {e}")

    if reranker != "none" and all_merged:
        all_merged = await _rerank(query, all_merged, reranker, top_k)
    else:
        all_merged.sort(key=lambda d: d.get("rrf_score", 0.0), reverse=True)
        all_merged = all_merged[:top_k]

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
        )
        for doc in all_merged
    ]

    effective_strategy = "bm25" if fallback_to_bm25 else strategy
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
        },
    )

    return results


async def _retrieve_single_collection(
    query: str,
    collection: str,
    top_k: int,
    strategy: str,
) -> tuple[list[dict[str, Any]], bool]:
    """Retrieve from a single collection, returning (merged_results, fallback_to_bm25)."""
    fetch_k = top_k * 4
    vector_results: list[dict[str, Any]] = []
    bm25_results: list[dict[str, Any]] = []
    fallback_to_bm25 = False

    if strategy in ("hybrid", "vector"):
        try:
            vector_results = await _vector_search(query, collection, fetch_k)
        except Exception as e:
            logger.warning(f"Vector search failed for '{collection}': {e}")
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
