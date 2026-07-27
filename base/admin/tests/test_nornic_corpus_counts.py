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
        if "coalesce(n.kind, '') AS kind" in query:
            return _FakeResult(
                rows=[
                    {"kind": "Concept", "count": 2},
                    {"kind": "Document", "count": 1},
                ]
            )
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
        if "count(n.embedding) AS count" in query:
            return _FakeResult(single={"count": 1})
        if "count(DISTINCT n.pack) AS count" in query:
            return _FakeResult(single={"count": 1})
        if "count(DISTINCT n.domain) AS count" in query:
            return _FakeResult(single={"count": 1})
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
                        "source": "Python pack",
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


class _QuerySession:
    def __init__(self, *, rows: list[dict[str, Any]] | None = None, count: int = 0):
        self.rows = rows or []
        self.count = count
        self.queries: list[str] = []
        self.params: list[dict[str, Any]] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def run(self, query: str, *args, **kwargs):
        del args
        self.queries.append(query)
        self.params.append(kwargs)
        if "RETURN count(n) AS count" in query:
            return _FakeResult(single={"count": self.count})
        return _FakeResult(rows=self.rows)


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
    assert any("coalesce(n.kind, '') AS kind" in query for query in session.queries)


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


def test_safe_query_pushes_filters_into_cypher(monkeypatch):
    from app.services import nornic_service

    session = _QuerySession(
        rows=[
            {
                "node": {
                    "id": "node-1",
                    "chunk_id": "chunk-1",
                    "scan_status": "flagged",
                    "domain": "python",
                }
            }
        ]
    )
    monkeypatch.setattr(nornic_service, "get_nornic_driver", lambda: _FakeDriver(session))

    rows = nornic_service.safe_query(
        "content_graph",
        filter_expr='(scan_status == "flagged") and domain == "python"',
        output_fields=["id", "chunk_id", "scan_status", "domain"],
        limit=5,
        offset=10,
        caller_org_id="org-a",
    )

    assert rows == [{"id": "node-1", "chunk_id": "chunk-1", "scan_status": "flagged", "domain": "python"}]
    query = session.queries[0]
    assert "WHERE" in query
    assert "toString(coalesce(n.scan_status, 'unscanned')) = $filter_0" in query
    assert "toString(coalesce(n.domain, '')) = $filter_1" in query
    assert query.index("WHERE") < query.index("SKIP")
    assert session.params[0]["filter_0"] == "flagged"
    assert session.params[0]["filter_1"] == "python"
    assert session.params[0]["caller_org_id"] == "org-a"


def test_safe_count_uses_cypher_count_with_filters(monkeypatch):
    from app.services import nornic_service

    session = _QuerySession(count=17)
    monkeypatch.setattr(nornic_service, "get_nornic_driver", lambda: _FakeDriver(session))

    count = nornic_service.safe_count("content_graph", filter_expr='scan_status == "unscanned"')

    assert count == 17
    assert "RETURN count(n) AS count" in session.queries[0]
    assert "toString(coalesce(n.scan_status, 'unscanned')) = $count_filter_0" in session.queries[0]
    assert session.params[0]["count_filter_0"] == "unscanned"


def test_scan_signal_trends_are_org_scoped_and_parameterized(monkeypatch):
    from app.services import nornic_service

    session = _QuerySession(
        rows=[
            {
                "signal": "ignore_previous_instructions",
                "domain": "python",
                "source": "https://docs.example/python",
                "count": 4,
                "first_seen_epoch": 100,
                "last_seen_epoch": 200,
            }
        ]
    )
    monkeypatch.setattr(nornic_service, "get_nornic_driver", lambda: _FakeDriver(session))

    rows = nornic_service.collection_scan_signal_trends(
        "content_graph",
        since_epoch=100,
        domain="python",
        signal="ignore_previous_instructions",
        caller_org_id="org-a",
    )

    assert rows[0]["count"] == 4
    assert "n.org_id = $caller_org_id" in session.queries[0]
    assert session.params[0]["caller_org_id"] == "org-a"
    assert session.params[0]["domain"] == "python"
    assert session.params[0]["signal"] == "ignore_previous_instructions"


def test_safe_query_scan_signal_filter_matches_a_single_csv_token(monkeypatch):
    from app.services import nornic_service

    session = _QuerySession(rows=[])
    monkeypatch.setattr(nornic_service, "get_nornic_driver", lambda: _FakeDriver(session))

    nornic_service.safe_query(
        "content_graph",
        filter_expr='scan_signal == "system_prompt_marker"',
    )

    assert "$filter_0 IN [signal IN split" in session.queries[0]
    assert session.params[0]["filter_0"] == "system_prompt_marker"
