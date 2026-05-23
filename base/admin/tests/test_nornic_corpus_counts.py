"""Tests for admin NornicDB corpus count normalization."""

from __future__ import annotations

from typing import Any


class _FakeResult:
    def __init__(self, rows: list[dict[str, Any]] | None = None, single: dict[str, Any] | None = None):
        self._rows = rows or []
        self._single = single

    def __iter__(self):
        return iter(self._rows)

    def single(self):
        return self._single


class _FakeSession:
    def __init__(self):
        self.queries: list[str] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def run(self, query: str, *args, **kwargs):
        del args, kwargs
        self.queries.append(query)
        if "content_node_count" in query:
            return _FakeResult(
                single={
                    "total_nodes": 3,
                    "content_node_count": 2,
                    "strict_chunk_count": 0,
                    "embedding_count": 1,
                    "pack_count": 1,
                }
            )
        if "RETURN count(r) AS c" in query:
            return _FakeResult(single={"c": 4})
        if "embedding_count" in query and "source_count" in query:
            return _FakeResult(
                rows=[
                    {
                        "pack_id": "go",
                        "node_count": 5300,
                        "chunk_count": 5120,
                        "embedding_count": 5120,
                        "doc_count": 42,
                        "source_count": 7,
                        "example_count": 100,
                        "context_card_count": 12,
                        "pack_card_count": 1,
                        "anti_pattern_count": 4,
                        "constraint_count": 10,
                        "external_ref_count": 8,
                        "edge_count": 900,
                        "domain": "generalist",
                        "language": "go",
                        "document_name": "Go pack",
                        "source_version": "1.0",
                        "source_release": "2026-05-01",
                        "quality_score": 0.91,
                        "trust_score": 0.88,
                        "freshness_score": 0.95,
                    }
                ]
            )
        if "collect({kind: kind, count: count})" in query:
            return _FakeResult(rows=[{"pack_id": "go", "counts": [{"kind": "Chunk", "count": 5120}]}])
        if "collect({edge_type: edge_type, count: count})" in query:
            return _FakeResult(rows=[{"pack_id": "go", "counts": [{"edge_type": "REFERENCES", "count": 900}]}])
        if "AS chunks" in query:
            return _FakeResult(
                rows=[
                    {
                        "domain": "python",
                        "doc_id": "",
                        "document_name": "Python pack",
                        "source_url": "",
                        "pack": "python",
                        "chunks": 2,
                    },
                    {
                        "domain": "empty",
                        "doc_id": "empty-doc",
                        "document_name": "Empty doc",
                        "source_url": "",
                        "pack": "empty-pack",
                        "chunks": 0,
                    },
                ]
            )
        raise AssertionError(f"Unexpected query: {query}")


class _FakeDriver:
    def __init__(self, session: _FakeSession):
        self._session = session

    def session(self, *args, **kwargs):
        del args, kwargs
        return self._session


def test_collection_stats_counts_content_bearing_nodes(monkeypatch):
    from app.services import nornic_service

    session = _FakeSession()
    monkeypatch.setattr(nornic_service, "get_nornic_driver", lambda: _FakeDriver(session))

    stats = nornic_service.collection_stats("content_graph")

    assert stats["chunk_count"] == 2
    assert stats["row_count"] == 2
    assert stats["strict_chunk_count"] == 0
    assert stats["node_count"] == 3
    assert stats["malformed_node_count"] == 1
    assert stats["edge_count"] == 4
    assert any("n.content" in query for query in session.queries)


def test_collection_corpus_summary_uses_fallback_document_keys(monkeypatch):
    from app.services import nornic_service

    session = _FakeSession()
    monkeypatch.setattr(nornic_service, "get_nornic_driver", lambda: _FakeDriver(session))

    summary = nornic_service.collection_corpus_summary("content_graph")

    assert summary["total_chunks"] == 2
    assert summary["total_documents"] == 1
    assert summary["total_sources"] == 1
    assert summary["domains_covered"] == 1


def test_collection_domain_hierarchy_uses_content_bearing_nodes(monkeypatch):
    from app.services import nornic_service

    session = _FakeSession()
    monkeypatch.setattr(nornic_service, "get_nornic_driver", lambda: _FakeDriver(session))

    hierarchy = nornic_service.collection_domain_hierarchy("content_graph")

    assert hierarchy == [
        {
            "domain": "python",
            "total_chunks": 2,
            "sources": [{"source": "Python pack", "chunks": 2}],
        }
    ]


def test_collection_pack_quality_reports_exposes_pack_level_quality(monkeypatch):
    from app.services import nornic_service

    session = _FakeSession()
    monkeypatch.setattr(nornic_service, "get_nornic_driver", lambda: _FakeDriver(session))

    reports = nornic_service.collection_pack_quality_reports("content_graph")

    assert reports == [
        {
            "pack_id": "go",
            "node_count": 5300,
            "chunk_count": 5120,
            "embedding_count": 5120,
            "doc_count": 42,
            "source_count": 7,
            "example_count": 100,
            "context_card_count": 12,
            "pack_card_count": 1,
            "anti_pattern_count": 4,
            "constraint_count": 10,
            "external_ref_count": 8,
            "edge_count": 900,
            "domain": "generalist",
            "language": "go",
            "document_name": "Go pack",
            "source_version": "1.0",
            "source_release": "2026-05-01",
            "quality_score": 0.91,
            "trust_score": 0.88,
            "freshness_score": 0.95,
            "node_kind_counts": {"Chunk": 5120},
            "edge_type_counts": {"REFERENCES": 900},
        }
    ]
