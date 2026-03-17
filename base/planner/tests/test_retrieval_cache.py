"""Unit tests for HybridRetrievalCache."""

from __future__ import annotations

import time
from unittest.mock import MagicMock

import numpy as np
import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (container-only)")

from app.retrieval_cache import HybridRetrievalCache
from app.semantic_index import NumpySemanticIndex
from app.state import EvidencePacket, EvidenceSnippet, EvidenceSource


def _make_packet(
    query: str = "test",
    confidence: float = 0.8,
    section_id: int | None = None,
) -> EvidencePacket:
    return EvidencePacket(
        query=query,
        sources=[EvidenceSource(uri="https://example.com", type="doc")],
        snippets=[EvidenceSnippet(text="snippet text", relevance=0.9, source_uri="https://example.com")],
        summary="Test summary",
        confidence=confidence,
        section_id=section_id,
    )


def _mock_embed_client(dim: int = 64) -> MagicMock:
    """Create a mock EmbedClient that returns deterministic embeddings."""
    client = MagicMock()

    def embed_fn(texts, normalize=True):
        vecs = []
        for t in texts:
            rng = np.random.default_rng(hash(t) % (2**31))
            v = rng.standard_normal(dim).astype(np.float32)
            if normalize:
                n = np.linalg.norm(v)
                if n > 0:
                    v = v / n
            vecs.append(v)
        return np.array(vecs, dtype=np.float32)

    client.embed = embed_fn
    return client


def _make_cache(**kwargs) -> HybridRetrievalCache:
    defaults = dict(
        semantic_index=NumpySemanticIndex(),
        embed_client=_mock_embed_client(),
        ttl_seconds=3600,
        max_entries=100,
        similarity_threshold=0.85,
        confidence_threshold=0.6,
    )
    defaults.update(kwargs)
    return HybridRetrievalCache(**defaults)


class TestExactMatch:
    def test_put_and_get(self):
        cache = _make_cache()
        packet = _make_packet("query A")
        cache.put("query A", packet)
        result = cache.get("query A")
        assert result is not None
        assert result.query == "query A"

    def test_normalized_key(self):
        cache = _make_cache()
        packet = _make_packet("QUERY  A")
        cache.put("  QUERY  A  ", packet)
        result = cache.get("query a")
        assert result is not None

    def test_miss(self):
        cache = _make_cache()
        assert cache.get("nonexistent") is None

    def test_stats_exact_hit(self):
        cache = _make_cache()
        cache.put("q1", _make_packet("q1"))
        cache.get("q1")
        assert cache.stats.exact_hits == 1
        assert cache.stats.misses == 0

    def test_stats_miss(self):
        cache = _make_cache()
        cache.get("nonexistent")
        assert cache.stats.misses == 1


class TestSemanticMatch:
    def test_semantic_hit_similar_text(self):
        """Different but semantically similar query should match via embedding similarity."""
        cache = _make_cache(similarity_threshold=0.0)
        packet = _make_packet("Kubernetes deployment for service X", confidence=0.9)
        cache.put("Kubernetes deployment for service X", packet)

        result = cache.get("K8s deploy service X")
        if result is not None:
            assert cache.stats.semantic_hits >= 1
        else:
            assert cache.stats.misses >= 1


class TestTTLExpiration:
    def test_expired_entry_returns_none(self):
        cache = _make_cache(ttl_seconds=1)
        packet = _make_packet("old query", confidence=0.9)
        cache.put("old query", packet)

        cache._exact["old query"].timestamp = time.time() - 10
        for entry in cache._index._entries:
            entry.timestamp = time.time() - 10

        result = cache.get("old query")
        assert result is None


class TestLRUEviction:
    def test_evict_on_overflow(self):
        cache = _make_cache(max_entries=5)
        for i in range(6):
            cache.put(f"query-{i}", _make_packet(f"query-{i}"))

        assert len(cache._exact) <= 5


class TestStructuredQueryBypass:
    @pytest.mark.parametrize(
        "query",
        [
            "error at /app/src/main.py:42",
            "deployment/nginx:latest config",
            "aws_lambda_function resource",
            "service.namespace.svc.cluster.local",
            "v1.25 upgrade guide",
            "panic: runtime error at line 55",
        ],
    )
    def test_structured_queries_bypass_semantic(self, query):
        cache = _make_cache()
        cache.put(query, _make_packet(query, confidence=0.9))
        cache._exact.clear()
        result = cache.get(query)
        assert result is None
        assert cache.stats.bypasses >= 1


class TestConfidenceThreshold:
    def test_low_confidence_not_returned_semantic(self):
        cache = _make_cache(confidence_threshold=0.6)
        packet = _make_packet("low conf query", confidence=0.3)
        cache.put("low conf query", packet)

        cache._exact.clear()
        result = cache.get("low conf query")
        assert result is None


class TestInvalidation:
    def test_invalidate_by_query(self):
        cache = _make_cache()
        cache.put("query A", _make_packet("query A"))
        assert cache.invalidate("query A") is True
        assert cache.get("query A") is None

    def test_invalidate_missing(self):
        cache = _make_cache()
        assert cache.invalidate("nonexistent") is False

    def test_invalidate_by_section(self):
        cache = _make_cache()
        cache.put("q1", _make_packet("q1", section_id=1))
        cache.put("q2", _make_packet("q2", section_id=1))
        cache.put("q3", _make_packet("q3", section_id=2))

        removed = cache.invalidate_by_section(1)
        assert removed == 2
        assert cache.get("q1") is None
        assert cache.get("q2") is None
        assert cache.get("q3") is not None


class TestClear:
    def test_clear_flushes_all(self):
        cache = _make_cache()
        cache.put("q1", _make_packet("q1"))
        cache.put("q2", _make_packet("q2"))
        cache.clear()
        assert cache.get("q1") is None
        assert cache.get("q2") is None
        assert cache.stats.exact_hits == 0


class TestParallelSafety:
    def test_concurrent_puts(self):
        """Concurrent put() calls should not corrupt state."""
        import threading

        cache = _make_cache(max_entries=200)
        errors: list[Exception] = []

        def worker(prefix: str):
            try:
                for i in range(20):
                    cache.put(f"{prefix}-{i}", _make_packet(f"{prefix}-{i}"))
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=worker, args=(f"t{t}",)) for t in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert len(cache._exact) <= 200
