"""Tests for the semantic taxonomy validator.

Validates:
- Override fires when keyword selection has low semantic similarity
- Graceful fallback when embedder is unavailable
- ADR query regression: must not classify as music_production
"""

from __future__ import annotations

from unittest.mock import patch

import numpy as np
import pytest

from .conftest import HAS_LANGGRAPH, skip_no_langgraph


# ---------------------------------------------------------------------------
# Helpers: mock embedder that returns deterministic vectors
# ---------------------------------------------------------------------------


def _make_deterministic_embeddings(texts: list[str], normalize: bool = True) -> np.ndarray:
    """Hash-based deterministic embeddings for testing.

    Generates reproducible vectors so that semantically similar text
    (sharing words) produces vectors with higher cosine similarity.
    """
    dim = 64
    rng = np.random.RandomState(42)
    base_vocab: dict[str, np.ndarray] = {}

    embeddings = []
    for text in texts:
        vec = np.zeros(dim, dtype=np.float32)
        for word in text.lower().split():
            if word not in base_vocab:
                base_vocab[word] = rng.randn(dim).astype(np.float32)
            vec += base_vocab[word]
        if normalize:
            norm = np.linalg.norm(vec)
            if norm > 0:
                vec /= norm
        embeddings.append(vec)
    return np.array(embeddings, dtype=np.float32)


class MockEmbedClient:
    def embed(self, texts: list[str], normalize: bool = True) -> np.ndarray:
        return _make_deterministic_embeddings(texts, normalize)


# ---------------------------------------------------------------------------
# Tests: Semantic taxonomy validation logic
# ---------------------------------------------------------------------------


@skip_no_langgraph
class TestValidateTaxonomy:
    """Unit tests for validate_taxonomy decision logic."""

    @pytest.fixture(autouse=True)
    def _reset_module(self):
        """Reset lazy-loaded state before each test."""
        from app.semantic_taxonomy import invalidate_cache

        invalidate_cache()
        yield
        invalidate_cache()

    def _patch_and_load(self):
        """Patch embed_client and load taxonomy embeddings."""
        return patch("app.embed_client.get_embed_client", return_value=MockEmbedClient())

    def test_override_on_mismatch(self):
        """Keyword says music_production but query is about software architecture."""
        with self._patch_and_load():
            from app.semantic_taxonomy import validate_taxonomy

            result = validate_taxonomy(
                query="Understand what ADR records are, architectural decision records",
                keyword_key="music_production",
            )
        assert result.semantic_top, "Should have semantic candidates"
        assert result.recommended_key != "music_production" or result.ambiguous

    def test_semantic_top_populated(self):
        """validate_taxonomy should return top-K candidates with scores."""
        with self._patch_and_load():
            from app.semantic_taxonomy import validate_taxonomy

            result = validate_taxonomy(
                query="Design a microservices architecture with event-driven patterns",
                keyword_key="generic",
                top_k=5,
            )
        assert len(result.semantic_top) <= 5
        assert all(isinstance(k, str) and isinstance(s, float) for k, s in result.semantic_top)

    def test_keyword_score_populated(self):
        """The keyword key's similarity score should be populated."""
        with self._patch_and_load():
            from app.semantic_taxonomy import validate_taxonomy

            result = validate_taxonomy(
                query="How do I mix and master a track in Ableton",
                keyword_key="music_production",
            )
        assert isinstance(result.keyword_score, float)

    def test_fallback_on_embed_failure(self):
        """When embedder fails, return keyword_key unchanged."""
        with patch(
            "app.embed_client.get_embed_client",
            side_effect=RuntimeError("TEI unavailable"),
        ):
            from app.semantic_taxonomy import validate_taxonomy

            result = validate_taxonomy(
                query="What is an ADR?",
                keyword_key="music_production",
            )
        assert result.recommended_key == "music_production"
        assert not result.overridden
        assert not result.ambiguous

    def test_empty_query_returns_keyword(self):
        from app.semantic_taxonomy import validate_taxonomy

        result = validate_taxonomy(query="", keyword_key="generic")
        assert result.recommended_key == "generic"
        assert not result.overridden

    def test_invalidate_cache_resets_state(self):
        from app.semantic_taxonomy import invalidate_cache

        invalidate_cache()
        from app import semantic_taxonomy

        assert not semantic_taxonomy._loaded
        assert semantic_taxonomy._taxonomy_embeddings is None


# ---------------------------------------------------------------------------
# Tests: ADR keyword classification regression
# ---------------------------------------------------------------------------


@skip_no_langgraph
class TestADRClassificationRegression:
    """Regression: ADR queries must route to software_architecture, not music."""

    @pytest.fixture(autouse=True)
    def _fresh_engine(self):
        """Reset the ScoringEngine singleton so YAML changes are picked up."""
        from app.entry_classifier_engine import reset_scoring_engine

        reset_scoring_engine()
        yield
        reset_scoring_engine()

    def test_adr_query_not_music_keyword_only(self):
        """Keyword classifier alone (after fixes) should pick software_architecture."""
        from app.entry_classifier_engine import get_scoring_engine

        engine = get_scoring_engine()
        query = "Understand what ADR records are - architectural decision records, what a sample one looks like and steps to make them"
        analysis = engine.analyze(query)

        active_domains = analysis.get("active_domains") or []
        domain_ref_counts = analysis.get("domain_ref_counts") or {}

        assert "software_architecture" in active_domains, (
            f"software_architecture should be in active_domains, got {active_domains}"
        )

        sa_count = domain_ref_counts.get("software_architecture", 0)
        mp_count = domain_ref_counts.get("music_production", 0)
        assert sa_count > mp_count, (
            f"software_architecture refs ({sa_count}) should exceed "
            f"music_production refs ({mp_count}); counts={domain_ref_counts}"
        )

    def test_adr_short_query_keyword_only(self):
        """Even the short form should trigger software_architecture."""
        from app.entry_classifier_engine import get_scoring_engine

        engine = get_scoring_engine()
        query = "what is an ADR, how to create an ADR, what is in an architectural design review"
        analysis = engine.analyze(query)

        active_domains = analysis.get("active_domains") or []
        assert "software_architecture" in active_domains, (
            f"software_architecture not found in {active_domains}"
        )

    def test_adr_taxonomy_resolution(self):
        """Full taxonomy resolution should produce software_architecture key."""
        from app.taxonomy_prompt_factory import resolve_taxonomy_metadata

        meta = resolve_taxonomy_metadata(
            active_domain_refs=["software_architecture"],
            task_size="medium",
            intent_class="knowledge",
            complexity_score=15.0,
            domain_ref_counts={"software_architecture": 3},
            query_text="Understand what ADR records are - architectural decision records",
        )
        assert meta["taxonomy_key"] == "software_architecture"
        assert "Software Architecture" in meta["path"]

    def test_music_needs_two_hits(self):
        """A single 'sample' should NOT trigger music_production after min_hits=2."""
        from app.entry_classifier_engine import get_scoring_engine

        engine = get_scoring_engine()
        query = "show me a sample configuration file"
        analysis = engine.analyze(query)

        active_domains = analysis.get("active_domains") or []
        assert "music_production" not in active_domains, (
            f"music_production should not trigger on single 'sample', got {active_domains}"
        )
