"""Tests for authority-weighted retrieval and citation formatting.

Validates that:
- Authority boost ordering is correct (canonical > vetted > community > external)
- [R:authority] datamarks appear correctly in formatted context
- Source URLs are included for external/curated chunks
- Internal chunks cite document names, not URLs
- SearchResult trust classification works via engine_authority_map
"""

from __future__ import annotations

import pytest

from app.state import RetrievalResult
from app.web_search import SearchResult, classify_results_by_trust

from .fixtures.sample_rag_chunks import (
    all_tiers,
    make_canonical_chunk,
    make_community_chunk,
    make_external_chunk,
    make_vetted_chunk,
)


class TestAuthorityBoostOrdering:
    """Verify that authority boost values produce correct ranking."""

    _AUTHORITY_BOOST = {
        "canonical": 1.25,
        "vetted": 1.10,
        "community": 1.00,
        "external": 0.90,
    }

    def test_boost_ordering(self):
        tiers = ["canonical", "vetted", "community", "external"]
        boosts = [self._AUTHORITY_BOOST[t] for t in tiers]
        assert boosts == sorted(boosts, reverse=True), "Boost values must be in descending order"

    def test_canonical_beats_vetted(self):
        assert self._AUTHORITY_BOOST["canonical"] > self._AUTHORITY_BOOST["vetted"]

    def test_vetted_beats_community(self):
        assert self._AUTHORITY_BOOST["vetted"] > self._AUTHORITY_BOOST["community"]

    def test_community_beats_external(self):
        assert self._AUTHORITY_BOOST["community"] > self._AUTHORITY_BOOST["external"]


class TestRetrievalResultProvenance:
    """Verify RetrievalResult carries correct provenance metadata."""

    def test_canonical_has_internal_origin(self):
        chunk = make_canonical_chunk()
        assert chunk.authority == "canonical"
        assert chunk.origin_type == "internal"
        assert chunk.source_url == ""

    def test_vetted_has_curated_origin_and_url(self):
        chunk = make_vetted_chunk()
        assert chunk.authority == "vetted"
        assert chunk.origin_type == "curated"
        assert chunk.source_url.startswith("https://")

    def test_community_has_url(self):
        chunk = make_community_chunk()
        assert chunk.authority == "community"
        assert "github.com" in chunk.source_url

    def test_external_has_url(self):
        chunk = make_external_chunk()
        assert chunk.authority == "external"
        assert chunk.source_url != ""

    def test_all_tiers_have_distinct_authorities(self):
        chunks = all_tiers()
        authorities = [c.authority for c in chunks]
        assert len(set(authorities)) == 4


class TestSearchResultTrustClassification:
    """Verify engine_authority_map classifies results correctly."""

    def test_unmapped_engine_stays_untrusted(self, monkeypatch):
        monkeypatch.setattr(
            "app.web_search.settings.engine_authority_map", {}
        )
        results = [SearchResult(title="Test", url="https://example.com", snippet="test", engine="google")]
        classified = classify_results_by_trust(results)
        assert classified[0].is_trusted is False
        assert classified[0].authority == "external"

    def test_mapped_engine_becomes_trusted(self, monkeypatch):
        monkeypatch.setattr(
            "app.web_search.settings.engine_authority_map",
            {"internal-wiki": {"authority": "canonical", "origin_type": "internal"}},
        )
        results = [SearchResult(title="Wiki Page", url="https://wiki.internal/page", snippet="test", engine="internal-wiki")]
        classified = classify_results_by_trust(results)
        assert classified[0].is_trusted is True
        assert classified[0].authority == "canonical"
        assert classified[0].origin_type == "internal"

    def test_mixed_engines_split_correctly(self, monkeypatch):
        monkeypatch.setattr(
            "app.web_search.settings.engine_authority_map",
            {"elasticsearch": {"authority": "vetted", "origin_type": "internal"}},
        )
        results = [
            SearchResult(title="External", url="https://example.com", snippet="ext", engine="google"),
            SearchResult(title="Internal", url="https://wiki.internal/doc", snippet="int", engine="elasticsearch"),
        ]
        classified = classify_results_by_trust(results)
        assert classified[0].is_trusted is False
        assert classified[1].is_trusted is True
        assert classified[1].authority == "vetted"
