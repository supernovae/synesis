"""BM25 index — owns the in-memory BM25Okapi index built from Milvus chunks.

Swap-on-write design: a background thread periodically builds a new index
from Milvus, then atomically swaps the reference. Searches are never blocked
by a refresh; they always read a consistent snapshot.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, fields
from typing import Any

from rank_bm25 import BM25Okapi
from synesis_telemetry import get_logger

logger = get_logger("synesis.bm25_service.index")

MILVUS_URI = os.getenv("MILVUS_URI", "http://synesis-milvus.synesis-rag.svc.cluster.local:19530")
MILVUS_TIMEOUT = int(os.getenv("MILVUS_TIMEOUT", "30"))
REFRESH_INTERVAL = int(os.getenv("BM25_REFRESH_INTERVAL_SECONDS", "1800"))

OUTPUT_FIELDS = [
    "chunk_id", "text", "document_name", "origin_type", "authority",
    "domain", "source_url", "heading_path", "context_prefix",
    "chunk_summary", "handler", "source_type", "keywords", "tags",
]

_STEM_SUFFIXES = (
    "ational", "izing", "ation", "ness", "ment", "ible", "able",
    "ical", "ful", "ous", "ive", "ing", "ies", "ed", "ly", "al",
    "er", "es", "s",
)


def _stem(word: str) -> str:
    for suffix in _STEM_SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[: -len(suffix)]
    return word


@dataclass(slots=True)
class Chunk:
    text: str = ""
    source: str = ""
    chunk_id: str = ""
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

    def to_result(self, score: float) -> dict[str, Any]:
        d: dict[str, Any] = {"bm25_score": score}
        for f in fields(self):
            d[f.name] = getattr(self, f.name)
        return d


@dataclass
class _Snapshot:
    """Immutable snapshot — searches read this without locks."""
    chunks: list[Chunk]
    index: BM25Okapi
    built_at: float


class BM25Index:
    """Thread-safe BM25 index with non-blocking refresh.

    Searches always read the latest snapshot without holding any lock.
    Refreshes build a new snapshot in a background thread then swap the
    reference atomically.
    """

    def __init__(self) -> None:
        self._snapshots: dict[str, _Snapshot] = {}
        self._refresh_running: dict[str, bool] = {}
        self._refresh_lock = threading.Lock()

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        return [_stem(w) for w in text.lower().split()]

    @staticmethod
    def _enriched_text(chunk: Chunk) -> str:
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

    def needs_refresh(self, collection: str) -> bool:
        snap = self._snapshots.get(collection)
        if snap is None:
            return True
        return (time.time() - snap.built_at) > REFRESH_INTERVAL

    def is_refreshing(self, collection: str) -> bool:
        return self._refresh_running.get(collection, False)

    def refresh(self, collection: str) -> None:
        with self._refresh_lock:
            if self._refresh_running.get(collection):
                return
            self._refresh_running[collection] = True

        try:
            self._do_refresh(collection)
        except Exception as e:
            logger.warning("bm25_refresh_failed", extra={"collection": collection, "error": str(e)[:200]})
        finally:
            with self._refresh_lock:
                self._refresh_running[collection] = False

    def _do_refresh(self, collection: str) -> None:
        from pymilvus import MilvusClient
        from pymilvus.exceptions import MilvusException

        client = MilvusClient(uri=MILVUS_URI, timeout=MILVUS_TIMEOUT)

        if collection not in client.list_collections():
            logger.warning("bm25_collection_not_found", extra={"collection": collection})
            return

        all_chunks: list[Chunk] = []

        try:
            iterator = client.query_iterator(
                collection_name=collection, filter="",
                output_fields=OUTPUT_FIELDS, batch_size=200,
            )
            while True:
                batch = iterator.next()
                if not batch:
                    break
                for row in batch:
                    all_chunks.append(Chunk(
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
                    ))
            iterator.close()
        except (MilvusException, AttributeError) as e:
            if isinstance(e, MilvusException) and "collection not loaded" in str(e).lower():
                try:
                    client.load_collection(collection_name=collection)
                except Exception:
                    pass
                raise
            if "query_iterator" in str(e).lower() or isinstance(e, AttributeError):
                logger.warning("bm25_refresh_iterator_fallback")
                all_chunks = self._fallback_query(client, collection)
            elif isinstance(e, MilvusException):
                raise

        if not all_chunks:
            logger.info("bm25_no_chunks", extra={"collection": collection})
            return

        tokenized = [self._tokenize(self._enriched_text(c)) for c in all_chunks]
        index = BM25Okapi(tokenized)

        self._snapshots[collection] = _Snapshot(
            chunks=all_chunks, index=index, built_at=time.time(),
        )

        logger.info("bm25_index_refreshed", extra={
            "collection": collection, "chunk_count": len(all_chunks),
        })

    def _fallback_query(self, client: Any, collection: str) -> list[Chunk]:
        all_chunks: list[Chunk] = []
        batch_size = 200
        offset = 0
        while True:
            results = client.query(
                collection_name=collection, filter="",
                output_fields=OUTPUT_FIELDS,
                limit=batch_size, offset=offset, timeout=MILVUS_TIMEOUT,
            )
            if not results:
                break
            for row in results:
                all_chunks.append(Chunk(
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
                ))
            if len(results) < batch_size:
                break
            offset += batch_size
        return all_chunks

    def search(self, query: str, collection: str, top_k: int = 10) -> list[dict[str, Any]]:
        snap = self._snapshots.get(collection)
        if snap is None:
            return []

        tokenized_query = self._tokenize(query)
        scores = snap.index.get_scores(tokenized_query)

        scored = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)[:top_k]
        return [
            snap.chunks[idx].to_result(float(score))
            for idx, score in scored if score > 0
        ]

    def collections(self) -> dict[str, dict[str, Any]]:
        return {
            coll: {
                "chunk_count": len(snap.chunks),
                "built_at": snap.built_at,
                "age_seconds": round(time.time() - snap.built_at),
            }
            for coll, snap in self._snapshots.items()
        }
