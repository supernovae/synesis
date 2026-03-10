"""Unit tests for SemanticIndex (NumpySemanticIndex)."""

from __future__ import annotations

import time

import numpy as np
from app.semantic_index import IndexEntry, NumpySemanticIndex
from app.state import EvidencePacket


def _make_packet(query: str = "test", confidence: float = 0.8) -> EvidencePacket:
    return EvidencePacket(query=query, summary="Test summary", confidence=confidence)


def _make_entry(
    query: str = "test query",
    embedding: list[float] | None = None,
    confidence: float = 0.8,
    timestamp: float | None = None,
    usage_count: int = 0,
) -> IndexEntry:
    if embedding is None:
        rng = np.random.default_rng(hash(query) % (2**31))
        embedding = rng.standard_normal(64).tolist()
    return IndexEntry(
        query_string=query,
        embedding=embedding,
        evidence_packet=_make_packet(query, confidence),
        timestamp=timestamp or time.time(),
        confidence=confidence,
        usage_count=usage_count,
    )


class TestNumpySemanticIndex:
    def test_insert_and_search_exact(self):
        idx = NumpySemanticIndex()
        entry = _make_entry("K8s deployment strategy")
        idx.insert(entry)

        results = idx.search(np.array(entry.embedding, dtype=np.float32), top_k=1)
        assert len(results) == 1
        hit, sim = results[0]
        assert hit.query_string == "K8s deployment strategy"
        assert sim > 0.99

    def test_search_returns_closest(self):
        idx = NumpySemanticIndex()
        e1 = _make_entry("alpha query", embedding=[1.0, 0.0, 0.0, 0.0])
        e2 = _make_entry("beta query", embedding=[0.0, 1.0, 0.0, 0.0])
        e3 = _make_entry("gamma query", embedding=[0.9, 0.1, 0.0, 0.0])
        idx.insert(e1)
        idx.insert(e2)
        idx.insert(e3)

        results = idx.search(np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32), top_k=1)
        assert len(results) == 1
        assert results[0][0].query_string == "alpha query"

    def test_no_false_match_orthogonal(self):
        idx = NumpySemanticIndex()
        e1 = _make_entry("Python web framework", embedding=[1.0, 0.0, 0.0, 0.0])
        idx.insert(e1)

        results = idx.search(np.array([0.0, 1.0, 0.0, 0.0], dtype=np.float32), top_k=1)
        assert len(results) == 1
        _, sim = results[0]
        assert sim < 0.1

    def test_evict_expired(self):
        idx = NumpySemanticIndex()
        old_entry = _make_entry("old query", timestamp=time.time() - 200)
        new_entry = _make_entry("new query", timestamp=time.time())
        idx.insert(old_entry)
        idx.insert(new_entry)

        evicted = idx.evict_expired(ttl_seconds=100)
        assert evicted == 1
        assert len(idx) == 1

    def test_evict_lru(self):
        idx = NumpySemanticIndex()
        for i in range(10):
            idx.insert(_make_entry(f"query-{i}", usage_count=i))

        evicted = idx.evict_lru(max_entries=5)
        assert evicted == 5
        assert len(idx) == 5
        remaining = [e.query_string for e in idx._entries]
        for i in range(5, 10):
            assert f"query-{i}" in remaining

    def test_delete(self):
        idx = NumpySemanticIndex()
        idx.insert(_make_entry("to-delete"))
        idx.insert(_make_entry("to-keep"))

        idx.delete("to-delete")
        assert len(idx) == 1
        results = idx.search(np.array(_make_entry("to-delete").embedding, dtype=np.float32), top_k=5)
        for hit, _ in results:
            assert hit.query_string != "to-delete"

    def test_dirty_flag_lazy_rebuild(self):
        idx = NumpySemanticIndex()
        idx.insert(_make_entry("first"))
        idx.insert(_make_entry("second"))
        idx.insert(_make_entry("third"))
        assert idx._dirty is True
        assert idx._matrix is None

        idx.search(np.array(_make_entry("first").embedding, dtype=np.float32))
        assert idx._dirty is False
        assert idx._matrix is not None

    def test_empty_index_search(self):
        idx = NumpySemanticIndex()
        results = idx.search(np.array([1.0, 0.0], dtype=np.float32))
        assert results == []

    def test_len(self):
        idx = NumpySemanticIndex()
        assert len(idx) == 0
        idx.insert(_make_entry("a"))
        assert len(idx) == 1

    def test_insert_duplicate_replaces(self):
        idx = NumpySemanticIndex()
        e1 = _make_entry("same query", confidence=0.5)
        e2 = _make_entry("same query", confidence=0.9)
        idx.insert(e1)
        idx.insert(e2)
        assert len(idx) == 1
        assert idx._entries[0].confidence == 0.9

    def test_top_k_ordering(self):
        idx = NumpySemanticIndex()
        emb_base = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32)
        for i in range(5):
            noise = np.random.default_rng(i).standard_normal(4).astype(np.float32) * 0.1
            idx.insert(_make_entry(f"q{i}", embedding=(emb_base + noise).tolist()))

        results = idx.search(emb_base, top_k=3)
        assert len(results) == 3
        sims = [s for _, s in results]
        assert sims == sorted(sims, reverse=True)
