"""Milvus writer with idempotent upsert by content hash and progress tracking."""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from typing import Any

from pymilvus import MilvusClient
from synesis_telemetry import get_logger

from .schema import SYNESIS_CATALOG, _ensure_index_and_load

logger = get_logger("synesis.indexer.milvus")

MILVUS_URI = "http://synesis-milvus.synesis-rag.svc.cluster.local:19530"


def chunk_id_hash(text: str, source: str) -> str:
    """Deterministic SHA256 hash for idempotent upserts."""
    content = f"{source}:{text[:500]}"
    return hashlib.sha256(content.encode()).hexdigest()[:64]


class MilvusWriter:
    """Manages Milvus upserts with idempotent content-hash deduplication."""

    def __init__(self, uri: str = MILVUS_URI):
        self.client = MilvusClient(uri=uri)

    def existing_chunk_ids(self, collection_name: str = SYNESIS_CATALOG) -> set[str]:
        """Return the set of chunk_ids already in a collection.

        Uses Milvus query iterator to avoid the 16384 offset+limit window cap.
        """
        if collection_name not in self.client.list_collections():
            return set()

        _ensure_index_and_load(self.client)

        ids: set[str] = set()
        batch_size = 5000
        iterator = self.client.query_iterator(
            collection_name=collection_name,
            filter="",
            output_fields=["chunk_id"],
            batch_size=batch_size,
        )
        try:
            rows = iterator.next()
            while rows:
                for row in rows:
                    ids.add(row["chunk_id"])
                rows = iterator.next()
        finally:
            iterator.close()

        return ids

    def upsert_batch(
        self,
        entities: list[dict[str, Any]],
        collection_name: str = SYNESIS_CATALOG,
    ) -> int:
        """Upsert entities in batches of 500. Returns total upserted count.

        Deduplicates by chunk_id within each batch to avoid Milvus rejecting
        batches with duplicate primary keys. Last occurrence wins (upsert semantics).
        """
        if not entities:
            return 0
        batch_size = 500
        total = 0
        for i in range(0, len(entities), batch_size):
            batch = entities[i : i + batch_size]
            deduped: dict[str, dict[str, Any]] = {}
            for ent in batch:
                deduped[ent["chunk_id"]] = ent
            if len(deduped) < len(batch):
                logger.warning(
                    "indexer_upsert_dedup_dropped",
                    extra={"dropped": len(batch) - len(deduped), "batch_size": len(batch)},
                )
            batch = list(deduped.values())
            self.client.upsert(collection_name=collection_name, data=batch)
            total += len(batch)
        return total

    def delete_by_doc_id(
        self,
        doc_id: str,
        collection_name: str = SYNESIS_CATALOG,
    ) -> int:
        """Delete all chunks belonging to a document. Returns deleted count."""
        result = self.client.delete(
            collection_name=collection_name,
            filter=f'doc_id == "{doc_id}"',
        )
        count = result.get("delete_count", 0) if isinstance(result, dict) else 0
        logger.info("indexer_chunks_deleted", extra={"count": count, "doc_id": doc_id})
        return count


@dataclass
class ProgressTracker:
    """Track indexing progress with counts and timing."""

    name: str
    total_chunks: int = 0
    total_sources: int = 0
    errors: int = 0
    start_time: float = field(default_factory=time.time)

    def log_source(self, source_name: str, chunk_count: int) -> None:
        self.total_sources += 1
        self.total_chunks += chunk_count
        logger.info(
            "indexer_source_complete",
            extra={
                "source_index": self.total_sources,
                "source": source_name,
                "chunks": chunk_count,
                "total_chunks": self.total_chunks,
            },
        )

    def log_error(self, source_name: str, error: str) -> None:
        self.errors += 1
        logger.warning(
            "indexer_source_error",
            extra={"source_index": self.total_sources, "source": source_name, "error": error},
        )

    def log_complete(self) -> None:
        elapsed = time.time() - self.start_time
        logger.info(
            "indexer_pipeline_complete",
            extra={
                "pipeline": self.name,
                "chunks": self.total_chunks,
                "sources": self.total_sources,
                "errors": self.errors,
                "elapsed_s": round(elapsed, 1),
            },
        )
