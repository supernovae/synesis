"""Tests for state.py -- validates the core typed contract shared by all nodes."""

from __future__ import annotations

import pytest
from app.state import (
    Confidence,
    NodeOutcome,
    NodeTrace,
    RetrievalParams,
    RetrievalResult,
    TaskType,
    WhatIfAnalysis,
)
from pydantic import ValidationError


class TestConfidence:
    def test_valid_range(self):
        assert Confidence(0.0) == 0.0
        assert Confidence(0.5) == 0.5
        assert Confidence(1.0) == 1.0

    def test_negative_rejected(self):
        with pytest.raises(ValueError, match=r"between 0\.0 and 1\.0"):
            Confidence(-0.1)

    def test_over_one_rejected(self):
        with pytest.raises(ValueError, match=r"between 0\.0 and 1\.0"):
            Confidence(1.01)

    def test_is_float(self):
        c = Confidence(0.75)
        assert isinstance(c, float)
        assert c + 0.25 == 1.0


class TestEnums:
    def test_task_types_are_strings(self):
        assert TaskType.CODE_GENERATION == "code_generation"
        assert TaskType.DEBUGGING.value == "debugging"

    def test_node_outcome_values(self):
        assert NodeOutcome.SUCCESS == "success"
        assert NodeOutcome.NEEDS_REVISION == "needs_revision"
        assert NodeOutcome.ERROR == "error"
        assert NodeOutcome.TIMEOUT == "timeout"


class TestNodeTrace:
    def test_valid_trace(self):
        t = NodeTrace(
            node_name="worker",
            reasoning="Generated bash script",
            confidence=0.8,
            outcome=NodeOutcome.SUCCESS,
        )
        assert t.node_name == "worker"
        assert t.timestamp > 0

    def test_confidence_out_of_range(self):
        with pytest.raises(ValidationError):
            NodeTrace(
                node_name="test",
                reasoning="bad",
                confidence=1.5,
                outcome=NodeOutcome.ERROR,
            )

    def test_default_values(self):
        t = NodeTrace(
            node_name="test",
            reasoning="r",
            confidence=0.5,
            outcome=NodeOutcome.SUCCESS,
        )
        assert t.latency_ms == 0.0
        assert t.tokens_used == 0
        assert t.assumptions == []


class TestWhatIfAnalysis:
    def test_valid_risk_levels(self):
        for level in ("low", "medium", "high", "critical"):
            w = WhatIfAnalysis(
                scenario="test",
                risk_level=level,
                explanation="desc",
            )
            assert w.risk_level == level

    def test_invalid_risk_level(self):
        with pytest.raises(ValidationError, match="risk_level"):
            WhatIfAnalysis(
                scenario="test",
                risk_level="extreme",
                explanation="desc",
            )


class TestRetrievalResult:
    def test_defaults(self):
        r = RetrievalResult(text="some code")
        assert r.source == "unknown"
        assert r.retrieval_source == "vector"
        assert r.rrf_score == 0.0
        assert r.repo_license == ""

    def test_full_result(self):
        r = RetrievalResult(
            text="def foo():",
            source="kubernetes/kubernetes",
            collection="code_go_v1",
            retrieval_source="both",
            vector_score=0.92,
            bm25_score=14.3,
            rrf_score=0.048,
            rerank_score=0.87,
            repo_license="Apache-2.0",
        )
        assert r.retrieval_source == "both"
        assert r.repo_license == "Apache-2.0"


class TestRetrievalParams:
    def test_defaults(self):
        p = RetrievalParams()
        assert p.strategy == "hybrid"
        assert p.reranker == "flashrank"
        assert p.top_k == 5

    def test_invalid_strategy(self):
        with pytest.raises(ValidationError):
            RetrievalParams(strategy="magic")

    def test_invalid_reranker(self):
        with pytest.raises(ValidationError):
            RetrievalParams(reranker="debug")
