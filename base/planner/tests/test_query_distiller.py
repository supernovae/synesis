"""Tests for query distiller — focused RAG and web query generation.

Validates:
  - distill_from_frame produces queries from problem/constraints, not deliverable echo
  - distill_web_from_frame produces non-echoing search-engine-friendly queries
  - decompose_section_queries returns multiple sub-query pairs for complex frames
  - _dedup_terms removes overlapping tokens
  - Fallback behavior when keyword-service is unavailable
"""

from __future__ import annotations

import re
from collections import Counter

from app.query_distiller import (
    _dedup_terms,
    _extract_key_terms,
    _extract_section_topic,
    decompose_section_queries,
    distill_from_frame,
    distill_web_from_frame,
)

_REALISTIC_FRAME = {
    "problem": "Design a production-ready AI assistant for an engineering organization",
    "goals": [
        "Answer questions about company docs",
        "Help write and review code",
        "Avoid confidently making up facts",
        "Escalate when lacking evidence",
        "Keep latency and cost reasonable",
    ],
    "deliverables": [
        "Main design goals",
        "Concrete architecture proposal",
        "Explanation of model choices",
        "Explanation of retrieval mechanism",
        "Description of failure modes and mitigations",
        "Explanation of system functionality",
    ],
    "constraints": [
        "Team size: 80 engineers",
        "Budget is limited",
        "Must support Kubernetes, Terraform, and Python workflows",
        "System should be useful within 90 days",
    ],
    "domain": "software_architecture",
}


class TestExtractSectionTopic:
    def test_splits_on_em_dash(self):
        topic = _extract_section_topic("Section: Model Choices \u2014 discuss small vs large models")
        assert "model choices" in topic.lower()
        assert "\u2014" not in topic

    def test_strips_section_prefix(self):
        topic = _extract_section_topic("Section: Architecture")
        assert topic == "Architecture"

    def test_passthrough_plain_text(self):
        topic = _extract_section_topic("Explain failure modes")
        assert topic == "Explain failure modes"


class TestDedupTerms:
    def test_removes_exact_overlap(self):
        result = _dedup_terms(["model", "choices", "latency"], {"model", "choices"})
        assert result == ["latency"]

    def test_removes_sub_token_overlap(self):
        result = _dedup_terms(["model choices", "latency cost"], {"model", "choices"})
        assert "model choices" not in result
        assert "latency cost" in result

    def test_case_insensitive(self):
        result = _dedup_terms(["Model", "LATENCY"], {"model"})
        assert "Model" not in result
        assert "LATENCY" in result

    def test_empty_exclude(self):
        result = _dedup_terms(["a", "b", "c"], set())
        assert result == ["a", "b", "c"]

    def test_deduplicates_within_list(self):
        result = _dedup_terms(["foo", "bar", "foo"], set())
        assert result == ["foo", "bar"]


class TestDistillFromFrame:
    def test_no_echo_chamber(self):
        """Key terms should come from problem/constraints, not echo the section title."""
        query = distill_from_frame(
            "Section: Explanation of model choices \u2014 discuss small vs large models",
            _REALISTIC_FRAME,
        )
        words = query.lower().split()
        counts = Counter(words)
        for word, count in counts.items():
            if len(word) > 2:
                assert count < 3, f"Word '{word}' appears {count}x in RAG query: {query}"

    def test_includes_problem_terms(self):
        """Query should contain terms from the problem, not just the section title."""
        query = distill_from_frame(
            "Section: Explanation of model choices \u2014 discuss small vs large models",
            _REALISTIC_FRAME,
        )
        q_lower = query.lower()
        assert "model choices" in q_lower or "explanation" in q_lower
        has_problem_term = any(
            t in q_lower for t in ["assistant", "engineering", "production", "organization"]
        )
        has_constraint_term = any(
            t in q_lower for t in ["budget", "kubernetes", "terraform", "engineers", "limited"]
        )
        assert has_problem_term or has_constraint_term, f"Query lacks problem/constraint terms: {query}"

    def test_includes_domain(self):
        query = distill_from_frame("Section: Architecture", _REALISTIC_FRAME)
        assert "software" in query.lower() or "architecture" in query.lower()

    def test_empty_frame_fallback(self):
        query = distill_from_frame("Section: Architecture", {})
        assert len(query) > 0
        assert "architecture" in query.lower()


class TestDistillWebFromFrame:
    def test_no_echo_chamber(self):
        query = distill_web_from_frame(
            "Section: Explanation of model choices \u2014 discuss small vs large models",
            _REALISTIC_FRAME,
        )
        words = query.lower().split()
        counts = Counter(words)
        for word, count in counts.items():
            if len(word) > 2:
                assert count < 3, f"Word '{word}' appears {count}x in web query: {query}"

    def test_length_limit(self):
        query = distill_web_from_frame(
            "Section: Explanation of model choices \u2014 discuss small vs large models",
            _REALISTIC_FRAME,
        )
        assert len(query) <= 80

    def test_search_engine_friendly(self):
        """Web query should be short, no newlines, no special chars."""
        query = distill_web_from_frame("Section: Failure modes", _REALISTIC_FRAME)
        assert "\n" not in query
        assert len(query.split()) <= 12


class TestDecomposeSectionQueries:
    def test_returns_at_least_primary(self):
        pairs = decompose_section_queries("Section: Architecture", _REALISTIC_FRAME)
        assert len(pairs) >= 1
        rag_q, web_q = pairs[0]
        assert len(rag_q) > 0
        assert len(web_q) > 0

    def test_returns_multiple_for_goals(self):
        pairs = decompose_section_queries("Section: Model choices", _REALISTIC_FRAME, max_queries=3)
        assert len(pairs) >= 1
        assert len(pairs) <= 3

    def test_sub_queries_are_distinct(self):
        """Each sub-query should contain different terms from the others."""
        pairs = decompose_section_queries(
            "Section: Model choices \u2014 small vs large models",
            _REALISTIC_FRAME,
            max_queries=3,
        )
        if len(pairs) > 1:
            queries = [rag for rag, _web in pairs]
            assert queries[0] != queries[1], "Sub-queries should be distinct"

    def test_max_queries_respected(self):
        pairs = decompose_section_queries("Section: Architecture", _REALISTIC_FRAME, max_queries=1)
        assert len(pairs) == 1

    def test_no_goals_returns_single(self):
        frame = {**_REALISTIC_FRAME, "goals": []}
        pairs = decompose_section_queries("Section: Architecture", frame, max_queries=3)
        assert len(pairs) == 1

    def test_each_pair_is_tuple(self):
        pairs = decompose_section_queries("Section: Architecture", _REALISTIC_FRAME)
        for pair in pairs:
            assert isinstance(pair, tuple)
            assert len(pair) == 2


class TestExtractKeyTermsFallback:
    """Verify word-frequency fallback when keyword-service is unavailable."""

    def test_extracts_meaningful_words(self):
        terms = _extract_key_terms("Design a production-ready AI assistant for engineering teams")
        assert len(terms) > 0
        assert all(len(t) > 2 for t in terms)
        stopwords = {"the", "for", "and", "with"}
        assert not any(t.lower() in stopwords for t in terms)

    def test_empty_input(self):
        assert _extract_key_terms("") == []

    def test_max_terms_respected(self):
        terms = _extract_key_terms("one two three four five six seven eight nine ten", max_terms=3)
        assert len(terms) <= 3
