"""Semantic index — the vector-based lookup layer inside the hybrid retrieval cache.

Stores embeddings of past retrieval queries, each associated with the
EvidencePacket produced by the Router.  Supports similarity search so
new queries can reuse cached evidence without re-retrieval.

This is the "materialized view" of past queries → evidence packets.

Architecture:
    SemanticIndex (Protocol)        — pluggable backend contract
    NumpySemanticIndex (default)    — brute-force cosine, zero deps beyond numpy
    FaissSemanticIndex (optional)   — ANN via faiss-cpu, up to ~100k entries
    MilvusSemanticIndex (future)    — external vector DB for cross-replica cache
"""

from __future__ import annotations

import logging
import time
from typing import Protocol, runtime_checkable

import numpy as np
from pydantic import BaseModel, Field

from .state import EvidencePacket

logger = logging.getLogger("synesis.semantic_index")


class IndexEntry(BaseModel):
    """One row in the semantic index — a past query and its evidence."""

    query_string: str
    embedding: list[float]
    evidence_packet: EvidencePacket
    timestamp: float = Field(default_factory=time.time)
    confidence: float = 0.0
    usage_count: int = 0


@runtime_checkable
class SemanticIndex(Protocol):
    """Pluggable vector index protocol."""

    def search(self, query_embedding: np.ndarray, top_k: int = 1) -> list[tuple[IndexEntry, float]]:
        """Return top_k entries with cosine similarity scores."""
        ...

    def insert(self, entry: IndexEntry) -> None:
        """Add an entry to the index."""
        ...

    def delete(self, query_string: str) -> None:
        """Remove an entry by exact query string."""
        ...

    def evict_expired(self, ttl_seconds: float) -> int:
        """Remove entries older than TTL. Returns count evicted."""
        ...

    def evict_lru(self, max_entries: int) -> int:
        """Remove LRU entries until under max_entries. Returns count evicted."""
        ...

    def __len__(self) -> int: ...


class NumpySemanticIndex:
    """Brute-force cosine similarity over a numpy matrix.

    Stores embeddings as a contiguous (N, D) float32 array.
    search() is a single matrix multiply + argsort.
    Adequate for <=512 entries (our default max_entries).
    """

    def __init__(self) -> None:
        self._entries: list[IndexEntry] = []
        self._matrix: np.ndarray | None = None
        self._dirty: bool = False

    def __len__(self) -> int:
        return len(self._entries)

    def search(self, query_embedding: np.ndarray, top_k: int = 1) -> list[tuple[IndexEntry, float]]:
        if not self._entries:
            return []

        if self._dirty or self._matrix is None:
            self._rebuild_matrix()

        assert self._matrix is not None
        q = np.asarray(query_embedding, dtype=np.float32).flatten()
        norm = np.linalg.norm(q)
        if norm > 0:
            q = q / norm

        scores = self._matrix @ q
        k = min(top_k, len(self._entries))
        if k >= len(scores):
            top_indices = np.argsort(-scores)[:k]
        else:
            top_indices = np.argpartition(-scores, k)[:k]
            top_indices = top_indices[np.argsort(-scores[top_indices])]

        results: list[tuple[IndexEntry, float]] = []
        for idx in top_indices:
            entry = self._entries[idx]
            entry.usage_count += 1
            results.append((entry, float(scores[idx])))
        return results

    def insert(self, entry: IndexEntry) -> None:
        for i, existing in enumerate(self._entries):
            if existing.query_string == entry.query_string:
                self._entries[i] = entry
                self._dirty = True
                return
        self._entries.append(entry)
        self._dirty = True

    def delete(self, query_string: str) -> None:
        before = len(self._entries)
        self._entries = [e for e in self._entries if e.query_string != query_string]
        if len(self._entries) != before:
            self._dirty = True

    def evict_expired(self, ttl_seconds: float) -> int:
        cutoff = time.time() - ttl_seconds
        before = len(self._entries)
        self._entries = [e for e in self._entries if e.timestamp >= cutoff]
        evicted = before - len(self._entries)
        if evicted > 0:
            self._dirty = True
            logger.debug("semantic_index_evict_expired", extra={"evicted": evicted})
        return evicted

    def evict_lru(self, max_entries: int) -> int:
        if len(self._entries) <= max_entries:
            return 0
        self._entries.sort(key=lambda e: (e.usage_count, e.timestamp))
        evict_count = len(self._entries) - max_entries
        self._entries = self._entries[evict_count:]
        self._dirty = True
        logger.debug("semantic_index_evict_lru", extra={"evicted": evict_count})
        return evict_count

    def _rebuild_matrix(self) -> None:
        if not self._entries:
            self._matrix = None
            self._dirty = False
            return
        vecs = np.array([e.embedding for e in self._entries], dtype=np.float32)
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        self._matrix = vecs / norms
        self._dirty = False
