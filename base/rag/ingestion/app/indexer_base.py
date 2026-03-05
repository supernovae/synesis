"""Shared base utilities for all Synesis RAG indexers.

Provides common infrastructure for Milvus connection, embedding,
batched upsert, and progress tracking. All three indexer types
(code, apispec, architecture) build on this.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
from pymilvus import CollectionSchema, DataType, FieldSchema, MilvusClient

logger = logging.getLogger("synesis.indexer")

MILVUS_URI = "http://synesis-milvus.synesis-rag.svc.cluster.local:19530"
EMBEDDER_URL = "http://embedder.synesis-rag.svc.cluster.local:8080/v1"
EMBEDDING_DIM = 384
EMBED_BATCH_SIZE = 32


def chunk_id_hash(text: str, source: str) -> str:
    """Deterministic SHA256 hash for idempotent upserts."""
    content = f"{source}:{text[:500]}"
    return hashlib.sha256(content.encode()).hexdigest()[:64]


def _ensure_index_and_load(client: MilvusClient, collection_name: str) -> None:
    """Create index on embedding field if missing, then load collection. Required before querying."""
    try:
        indexes = client.list_indexes(collection_name=collection_name)
        has_embedding_index = indexes and any("embedding" in str(idx).lower() for idx in indexes)
    except Exception:
        has_embedding_index = False
    if not has_embedding_index:
        try:
            index_params = MilvusClient.prepare_index_params()
            index_params.add_index(
                field_name="embedding",
                index_type="IVF_FLAT",
                metric_type="COSINE",
                params={"nlist": 128},
            )
            client.create_index(collection_name=collection_name, index_params=index_params)
            logger.info(f"Created index on '{collection_name}'")
        except Exception as e:
            if "already" not in str(e).lower():
                raise
    client.load_collection(collection_name=collection_name)


class EmbedClient:
    """Batch embedding client using the Synesis embedder service."""

    def __init__(self, url: str = EMBEDDER_URL, model: str = "all-MiniLM-L6-v2"):
        self.url = url
        self.model = model

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        all_embeddings: list[list[float]] = []
        for i in range(0, len(texts), EMBED_BATCH_SIZE):
            batch = texts[i : i + EMBED_BATCH_SIZE]
            resp = httpx.post(
                f"{self.url}/embeddings",
                json={"input": batch, "model": self.model},
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
            batch_embeddings = [item["embedding"] for item in data["data"]]
            all_embeddings.extend(batch_embeddings)

        return all_embeddings


class MilvusWriter:
    """Manages Milvus collections with idempotent upsert by content hash."""

    def __init__(self, uri: str = MILVUS_URI):
        self.client = MilvusClient(uri=uri)

    def ensure_collection(
        self,
        collection_name: str,
        extra_fields: list[FieldSchema] | None = None,
        description: str = "",
    ) -> None:
        if collection_name in self.client.list_collections():
            logger.info(f"Collection '{collection_name}' already exists")
            _ensure_index_and_load(self.client, collection_name)
            return

        fields = [
            FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
            FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=8192),
            FieldSchema(name="source", dtype=DataType.VARCHAR, max_length=512),
            FieldSchema(name="language", dtype=DataType.VARCHAR, max_length=32),
            FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
        ]
        if extra_fields:
            embed_field = fields.pop()
            fields.extend(extra_fields)
            fields.append(embed_field)

        schema = CollectionSchema(
            fields=fields,
            description=description or f"Synesis RAG: {collection_name}",
        )

        self.client.create_collection(collection_name=collection_name, schema=schema)
        _ensure_index_and_load(self.client, collection_name)
        logger.info(f"Created collection '{collection_name}'")

    def existing_chunk_ids(self, collection_name: str) -> set[str]:
        """Return the set of chunk_ids already in a collection.

        Used by indexers to skip re-embedding unchanged content.
        Only loads ids (not vectors), so memory-efficient.
        """
        if collection_name not in self.client.list_collections():
            return set()

        # Milvus requires index + load before querying (e.g. after restart, or index missing)
        _ensure_index_and_load(self.client, collection_name)

        ids: set[str] = set()
        batch_size = 5000
        offset = 0
        while True:
            rows = self.client.query(
                collection_name=collection_name,
                filter="",
                output_fields=["chunk_id"],
                limit=batch_size,
                offset=offset,
            )
            if not rows:
                break
            for row in rows:
                ids.add(row["chunk_id"])
            if len(rows) < batch_size:
                break
            offset += batch_size

        return ids

    def upsert_batch(
        self,
        collection_name: str,
        entities: list[dict[str, Any]],
    ) -> int:
        if not entities:
            return 0
        batch_size = 500
        total = 0
        for i in range(0, len(entities), batch_size):
            batch = entities[i : i + batch_size]
            self.client.upsert(collection_name=collection_name, data=batch)
            total += len(batch)
        return total


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
        logger.info(f"  [{self.total_sources}] {source_name}: {chunk_count} chunks (total: {self.total_chunks})")

    def log_error(self, source_name: str, error: str) -> None:
        self.errors += 1
        logger.warning(f"  [{self.total_sources}] {source_name}: ERROR - {error}")

    def log_complete(self) -> None:
        elapsed = time.time() - self.start_time
        logger.info(
            f"=== {self.name} complete: {self.total_chunks} chunks from "
            f"{self.total_sources} sources ({self.errors} errors) "
            f"in {elapsed:.1f}s ==="
        )
