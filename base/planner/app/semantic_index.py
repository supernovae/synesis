"""Semantic index — the vector-based lookup layer inside the hybrid retrieval cache.

Stores embeddings of past retrieval queries, each associated with the
EvidencePacket produced by the Router.  Supports similarity search so
new queries can reuse cached evidence without re-retrieval.

This is the "materialized view" of past queries → evidence packets.

Architecture:
    SemanticIndex (Protocol)        — pluggable backend contract
    NumpySemanticIndex (default)    — brute-force cosine, zero deps beyond numpy
    RedisSemanticIndex (optional)   — shared cross-replica cache via Redis
    FaissSemanticIndex (optional)   — ANN via faiss-cpu, up to ~100k entries
"""

from __future__ import annotations

import hashlib
import json
import logging
import struct
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
    model_version: str = ""


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


# ---------------------------------------------------------------------------
# Redis-backed semantic index (cross-replica shared cache)
# ---------------------------------------------------------------------------


def _embedding_to_bytes(embedding: list[float]) -> bytes:
    return struct.pack(f"{len(embedding)}f", *embedding)


def _bytes_to_embedding(data: bytes) -> list[float]:
    count = len(data) // 4
    return list(struct.unpack(f"{count}f", data))


def _query_hash(query_string: str) -> str:
    return hashlib.sha256(query_string.encode("utf-8")).hexdigest()[:24]


class RedisSemanticIndex:
    """Shared semantic index backed by Redis hashes.

    Each entry is stored as a Redis hash at ``{prefix}{query_hash}`` with
    fields for the embedding (packed float32 bytes), serialized evidence
    packet, and metadata.  search() fetches all keys via SCAN and computes
    cosine similarity in-process with numpy — adequate for <= 512 entries.
    """

    def __init__(
        self,
        redis_url: str,
        prefix: str = "synesis:cache:idx:",
        model_version: str = "",
        ttl_seconds: int = 86_400,
    ) -> None:
        import redis as redis_lib

        self._r = redis_lib.Redis.from_url(redis_url, decode_responses=False)
        self._prefix = prefix
        self._model_version = model_version
        self._ttl_seconds = ttl_seconds

    def __len__(self) -> int:
        return sum(1 for _ in self._r.scan_iter(match=f"{self._prefix}*", count=200))

    def search(self, query_embedding: np.ndarray, top_k: int = 1) -> list[tuple[IndexEntry, float]]:
        q = np.asarray(query_embedding, dtype=np.float32).flatten()
        norm = np.linalg.norm(q)
        if norm > 0:
            q = q / norm

        entries: list[tuple[IndexEntry, np.ndarray]] = []
        for key in self._r.scan_iter(match=f"{self._prefix}*", count=200):
            raw = self._r.hgetall(key)
            if not raw:
                continue
            try:
                entry, vec = self._decode_hash(raw)
                entries.append((entry, vec))
            except Exception:
                logger.debug("redis_index_decode_error", extra={"key": key}, exc_info=True)

        if not entries:
            return []

        vecs = np.array([v for _, v in entries], dtype=np.float32)
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        vecs = vecs / norms

        scores = vecs @ q
        k = min(top_k, len(entries))
        if k >= len(scores):
            top_indices = np.argsort(-scores)[:k]
        else:
            top_indices = np.argpartition(-scores, k)[:k]
            top_indices = top_indices[np.argsort(-scores[top_indices])]

        results: list[tuple[IndexEntry, float]] = []
        for idx in top_indices:
            entry = entries[idx][0]
            entry.usage_count += 1
            self._bump_usage(entry.query_string, entry.usage_count)
            results.append((entry, float(scores[idx])))
        return results

    def insert(self, entry: IndexEntry) -> None:
        key = f"{self._prefix}{_query_hash(entry.query_string)}"
        data: dict[bytes, bytes] = {
            b"query_string": entry.query_string.encode("utf-8"),
            b"embedding": _embedding_to_bytes(entry.embedding),
            b"packet": entry.evidence_packet.model_dump_json().encode("utf-8"),
            b"timestamp": str(entry.timestamp).encode("utf-8"),
            b"confidence": str(entry.confidence).encode("utf-8"),
            b"usage_count": str(entry.usage_count).encode("utf-8"),
            b"model_version": (entry.model_version or "").encode("utf-8"),
        }
        self._r.hset(key, mapping=data)  # type: ignore[arg-type]
        if self._ttl_seconds > 0:
            self._r.expire(key, self._ttl_seconds)

    def delete(self, query_string: str) -> None:
        key = f"{self._prefix}{_query_hash(query_string)}"
        self._r.delete(key)

    def evict_expired(self, ttl_seconds: float) -> int:
        cutoff = time.time() - ttl_seconds
        evicted = 0
        for key in list(self._r.scan_iter(match=f"{self._prefix}*", count=200)):
            raw_ts = self._r.hget(key, b"timestamp")
            if raw_ts is not None:
                try:
                    ts = float(raw_ts)
                    if ts < cutoff:
                        self._r.delete(key)
                        evicted += 1
                except (ValueError, TypeError):
                    pass
        if evicted:
            logger.debug("redis_index_evict_expired", extra={"evicted": evicted})
        return evicted

    def evict_lru(self, max_entries: int) -> int:
        all_keys: list[tuple[bytes, float, int]] = []
        for key in self._r.scan_iter(match=f"{self._prefix}*", count=200):
            raw = self._r.hmget(key, b"usage_count", b"timestamp")
            usage = int(raw[0] or 0) if raw[0] else 0
            ts = float(raw[1] or 0) if raw[1] else 0.0
            all_keys.append((key, ts, usage))

        if len(all_keys) <= max_entries:
            return 0

        all_keys.sort(key=lambda x: (x[2], x[1]))
        evict_count = len(all_keys) - max_entries
        for k, _, _ in all_keys[:evict_count]:
            self._r.delete(k)
        logger.debug("redis_index_evict_lru", extra={"evicted": evict_count})
        return evict_count

    # --- internal helpers ---

    def _bump_usage(self, query_string: str, new_count: int) -> None:
        key = f"{self._prefix}{_query_hash(query_string)}"
        try:
            self._r.hset(key, b"usage_count", str(new_count).encode("utf-8"))
        except Exception:
            pass

    def _decode_hash(self, raw: dict[bytes, bytes]) -> tuple[IndexEntry, np.ndarray]:
        query_string = raw[b"query_string"].decode("utf-8")
        emb_bytes = raw[b"embedding"]
        embedding = _bytes_to_embedding(emb_bytes)
        vec = np.array(embedding, dtype=np.float32)
        packet_data = json.loads(raw[b"packet"].decode("utf-8"))
        packet = EvidencePacket(**packet_data)
        timestamp = float(raw.get(b"timestamp", b"0"))
        confidence = float(raw.get(b"confidence", b"0"))
        usage_count = int(raw.get(b"usage_count", b"0"))
        model_version = raw.get(b"model_version", b"").decode("utf-8")
        entry = IndexEntry(
            query_string=query_string,
            embedding=embedding,
            evidence_packet=packet,
            timestamp=timestamp,
            confidence=confidence,
            usage_count=usage_count,
            model_version=model_version,
        )
        return entry, vec
