"""Tests for multi-source search federation and source-aware scoring.

Validates:
- SearchResult source_id field is populated
- Source-weighted conversion produces correct score scaling
- UnifiedResult carries source_id

Tests that require the full langgraph import chain (e.g. _fallback_packet)
are guarded with a langgraph import check so they run in CI but are skipped
in local dev environments without the full dependency set.
"""

from __future__ import annotations

import pytest

from app.web_search import SearchResult

_has_langgraph = True
try:
    import langgraph  # noqa: F401
except ImportError:
    _has_langgraph = False


class TestSearchResultSourceId:
    def test_source_id_field(self):
        r = SearchResult(title="t", url="u", snippet="s", source_id="jira_internal")
        assert r.source_id == "jira_internal"

    def test_defaults_empty(self):
        r = SearchResult(title="t", url="u", snippet="s")
        assert r.source_id == ""


@pytest.mark.skipif(not _has_langgraph, reason="langgraph not installed locally")
class TestUnifiedResultSourceId:
    def test_source_id_field_exists(self):
        from app.unified_retrieval import UnifiedResult

        r = UnifiedResult(text="test", source_id="code_general")
        assert r.source_id == "code_general"

    def test_source_id_defaults_empty(self):
        from app.unified_retrieval import UnifiedResult

        r = UnifiedResult(text="test")
        assert r.source_id == ""


@pytest.mark.skipif(not _has_langgraph, reason="langgraph not installed locally")
class TestWebToUnifiedSourceId:
    def test_source_id_preserved(self):
        from app.unified_retrieval import _web_to_unified

        results = [
            SearchResult(
                title="Test",
                url="https://github.com/test",
                snippet="some code",
                engine="github",
                score=0.8,
                relevance=0.9,
                source_id="code_general",
            ),
        ]
        unified = _web_to_unified(results)
        assert len(unified) == 1
        assert unified[0].source_id == "code_general"

    def test_source_weight_applied(self):
        from app.unified_retrieval import _web_to_unified

        results = [
            SearchResult(
                title="Test",
                url="https://example.com",
                snippet="content",
                score=0.5,
                relevance=1.0,
                authority="external",
            ),
        ]
        base = _web_to_unified(results, source_weight=1.0)
        weighted = _web_to_unified(results, source_weight=1.5)
        assert weighted[0].score > base[0].score


@pytest.mark.skipif(not _has_langgraph, reason="langgraph not installed locally")
class TestFallbackPacketProvenance:
    def test_source_id_in_metadata(self):
        from app.nodes.router import _fallback_packet
        from app.unified_retrieval import UnifiedResult

        results = [
            UnifiedResult(
                text="test content",
                source_url="https://github.com/test",
                authority="community",
                origin_type="external",
                retrieval_source="web",
                score=0.8,
                source_id="code_general",
            ),
        ]
        packet = _fallback_packet("test query", results)
        assert len(packet.sources) == 1
        assert packet.sources[0].metadata.get("source_id") == "code_general"

    def test_no_source_id_when_empty(self):
        from app.nodes.router import _fallback_packet
        from app.unified_retrieval import UnifiedResult

        results = [
            UnifiedResult(
                text="test content",
                source_url="https://example.com",
                retrieval_source="rag",
                score=0.8,
            ),
        ]
        packet = _fallback_packet("test query", results)
        assert "source_id" not in packet.sources[0].metadata
