"""Hybrid retrieval cache — exact-match dict + semantic index.

Stores summarized evidence packets (not raw results) so a cache hit
skips both retrieval AND summarization.  The semantic layer acts as a
materialized view of past queries, catching near-duplicate retrieval
requests that would otherwise hammer the backend on every critic→router
refinement loop.

Two tiers:
    1. Exact dict  (O(1), keyed on normalized query string)
    2. SemanticIndex (cosine similarity on query embeddings)

Structured-query bypass: queries containing file paths, k8s object
names, version strings, etc. skip semantic lookup because embedding
similarity is misleading for precise identifiers.
"""

from __future__ import annotations

import logging
import re
import threading
import time

import numpy as np
from pydantic import BaseModel, Field

from .embed_client import EmbedClient
from .semantic_index import IndexEntry, NumpySemanticIndex, SemanticIndex
from .state import EvidencePacket

logger = logging.getLogger("synesis.retrieval_cache")

_WHITESPACE_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[^\w\s]")

_STRUCTURED_PATTERNS = [
    re.compile(r"[/\\][\w.-]+\.\w{1,4}"),
    re.compile(r"\b(?:deployment|pod|svc|configmap|secret|ingress|pvc|statefulset|daemonset|job|cronjob)[/:]"),
    re.compile(r"\b(?:aws_|azurerm_|google_|module\.)"),
    re.compile(r"\b[\w-]+\.[\w-]+\.svc\.cluster\.local"),
    re.compile(r"(?:line\s*\d+|:\d+:\d+)"),
    re.compile(r"\b(?:error|exception|traceback|panic)\b.*(?:at|in|from)\b", re.IGNORECASE),
    re.compile(r"\b[vV]\d+\.\d+"),
]


class CacheEntry(BaseModel):
    evidence_packet: EvidencePacket
    query_string: str
    normalized_key: str
    timestamp: float = Field(default_factory=time.time)
    confidence: float = 0.0
    usage_count: int = 0


class CacheStats(BaseModel):
    exact_hits: int = 0
    semantic_hits: int = 0
    misses: int = 0
    evictions: int = 0
    bypasses: int = 0


class HybridRetrievalCache:
    """Two-tier evidence packet cache: exact dict + semantic index."""

    def __init__(
        self,
        semantic_index: SemanticIndex,
        embed_client: EmbedClient,
        ttl_seconds: float = 86_400,
        max_entries: int = 512,
        similarity_threshold: float = 0.85,
        confidence_threshold: float = 0.6,
    ) -> None:
        self._exact: dict[str, CacheEntry] = {}
        self._index = semantic_index
        self._embed = embed_client
        self._ttl = ttl_seconds
        self._max = max_entries
        self._sim_thresh = similarity_threshold
        self._conf_thresh = confidence_threshold
        self._stats = CacheStats()
        self._lock = threading.Lock()

    # --- Public API ---

    def get(self, query: str) -> EvidencePacket | None:
        """Look up evidence for a query. Returns None on miss."""
        key = self._normalize_key(query)

        with self._lock:
            entry = self._exact.get(key)
            if entry is not None and self._validate(entry):
                entry.usage_count += 1
                self._stats.exact_hits += 1
                return entry.evidence_packet

            if self._is_structured_query(query):
                self._stats.bypasses += 1
                self._stats.misses += 1
                return None

        try:
            embedding = self._embed.embed([query], normalize=True)
            if embedding.size == 0:
                with self._lock:
                    self._stats.misses += 1
                return None
        except Exception:
            logger.warning("cache_embed_failed", exc_info=True)
            with self._lock:
                self._stats.misses += 1
            return None

        with self._lock:
            results = self._index.search(embedding[0], top_k=1)
            if results:
                hit_entry, similarity = results[0]
                if similarity >= self._sim_thresh:
                    cache_entry = self._exact.get(self._normalize_key(hit_entry.query_string))
                    if cache_entry and self._validate(cache_entry, similarity):
                        cache_entry.usage_count += 1
                        self._stats.semantic_hits += 1
                        return cache_entry.evidence_packet

            self._stats.misses += 1
            return None

    def put(self, query: str, packet: EvidencePacket) -> None:
        """Store an evidence packet for the given query in both tiers."""
        key = self._normalize_key(query)

        try:
            embedding = self._embed.embed([query], normalize=True)
        except Exception:
            logger.warning("cache_embed_failed_on_put", exc_info=True)
            embedding = np.empty((0, 0), dtype=np.float32)

        now = time.time()
        entry = CacheEntry(
            evidence_packet=packet,
            query_string=query,
            normalized_key=key,
            timestamp=now,
            confidence=packet.confidence,
        )

        with self._lock:
            self._exact[key] = entry
            if embedding.size > 0:
                idx_entry = IndexEntry(
                    query_string=query,
                    embedding=embedding[0].tolist(),
                    evidence_packet=packet,
                    timestamp=now,
                    confidence=packet.confidence,
                )
                self._index.insert(idx_entry)
            self._evict()

    def invalidate(self, query: str) -> bool:
        """Remove a specific entry from both tiers. Returns True if found."""
        key = self._normalize_key(query)
        with self._lock:
            removed = key in self._exact
            self._exact.pop(key, None)
            self._index.delete(query)
            return removed

    def invalidate_by_section(self, section_id: int) -> int:
        """Remove all entries for a given section_id. Returns count removed."""
        with self._lock:
            to_remove = [k for k, v in self._exact.items() if v.evidence_packet.section_id == section_id]
            for k in to_remove:
                entry = self._exact.pop(k)
                self._index.delete(entry.query_string)
            return len(to_remove)

    def clear(self) -> None:
        """Flush both tiers."""
        with self._lock:
            self._exact.clear()
            self._index.evict_lru(0)
            self._stats = CacheStats()

    @property
    def stats(self) -> CacheStats:
        return self._stats.model_copy()

    # --- Internal ---

    @staticmethod
    def _normalize_key(query: str) -> str:
        text = query.lower().strip()
        text = _PUNCT_RE.sub(" ", text)
        text = _WHITESPACE_RE.sub(" ", text).strip()
        return text

    def _validate(self, entry: CacheEntry, similarity: float = 1.0) -> bool:
        age = time.time() - entry.timestamp
        if age > self._ttl:
            return False
        if entry.confidence < self._conf_thresh:
            return False
        return similarity >= self._sim_thresh

    @staticmethod
    def _is_structured_query(query: str) -> bool:
        return any(pattern.search(query) for pattern in _STRUCTURED_PATTERNS)

    def _evict(self) -> None:
        evicted = self._index.evict_expired(self._ttl)
        if evicted:
            self._stats.evictions += evicted
            expired_keys = [k for k, v in self._exact.items() if (time.time() - v.timestamp) > self._ttl]
            for k in expired_keys:
                self._exact.pop(k, None)

        if len(self._exact) > self._max:
            overflow = len(self._exact) - self._max
            lru_evicted = self._index.evict_lru(self._max)
            self._stats.evictions += lru_evicted
            sorted_entries = sorted(self._exact.items(), key=lambda kv: (kv[1].usage_count, kv[1].timestamp))
            for k, _ in sorted_entries[:overflow]:
                self._exact.pop(k, None)


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_cache: HybridRetrievalCache | None = None


def get_retrieval_cache() -> HybridRetrievalCache:
    global _cache
    if _cache is None:
        from .config import settings
        from .embed_client import get_embed_client

        _cache = HybridRetrievalCache(
            semantic_index=NumpySemanticIndex(),
            embed_client=get_embed_client(),
            ttl_seconds=settings.retrieval_cache_ttl,
            max_entries=settings.retrieval_cache_max_entries,
            similarity_threshold=settings.retrieval_cache_similarity_threshold,
            confidence_threshold=settings.retrieval_cache_confidence_threshold,
        )
    return _cache
