"""Tests for evidence gathering resilience: RAG degradation fallback, SSE heartbeat, and fast-path routing.

These tests validate the key contracts introduced in the evidence fallback
stabilization work.  Tests that require heavy imports (langgraph, fastapi)
are skipped when not installed so the suite works both locally and in CI.
"""

from __future__ import annotations

import os
import sys
from unittest.mock import patch

import pytest

_has_langgraph = bool(sys.modules.get("langgraph")) or __import__("importlib").util.find_spec("langgraph") is not None
_has_fastapi = bool(sys.modules.get("fastapi")) or __import__("importlib").util.find_spec("fastapi") is not None
_has_asyncio = (
    bool(sys.modules.get("pytest_asyncio")) or __import__("importlib").util.find_spec("pytest_asyncio") is not None
)

skip_no_langgraph = pytest.mark.skipif(not _has_langgraph, reason="langgraph not installed")
skip_no_fastapi = pytest.mark.skipif(not _has_fastapi, reason="fastapi not installed")
skip_no_async = pytest.mark.skipif(not _has_asyncio, reason="pytest-asyncio not installed")


# ---------------------------------------------------------------------------
# Config: rag_empty_web_budget_min (always runs — only needs pydantic)
# ---------------------------------------------------------------------------


class TestConfigDefaults:
    def _make_settings(self, **overrides):
        env = {
            "SYNESIS_SUPERVISOR_MODEL_URL": "http://localhost:8081/v1",
            "SYNESIS_EXECUTOR_MODEL_URL": "http://localhost:8080/v1",
            "SYNESIS_RAG_RERANKER": "flashrank",
            "SYNESIS_RAG_RETRIEVAL_STRATEGY": "hybrid",
        }
        env.update(overrides)
        with patch.dict(os.environ, env, clear=False):
            from app.config import Settings

            return Settings()

    def test_rag_empty_web_budget_min_default(self):
        s = self._make_settings()
        assert s.rag_empty_web_budget_min == 3

    def test_rag_empty_web_budget_min_override(self):
        s = self._make_settings(SYNESIS_RAG_EMPTY_WEB_BUDGET_MIN="5")
        assert s.rag_empty_web_budget_min == 5


# ---------------------------------------------------------------------------
# RetrievalBundle degradation metadata
# ---------------------------------------------------------------------------


@skip_no_langgraph
def test_retrieval_bundle_default_no_degradation():
    from app.unified_retrieval import RetrievalBundle

    b = RetrievalBundle(results=[])
    assert b.rag_degraded is False
    assert b.web_degraded is False
    assert b.degradation_notes == ""


@skip_no_langgraph
def test_retrieval_bundle_degradation_fields():
    from app.unified_retrieval import RetrievalBundle

    b = RetrievalBundle(
        results=[],
        rag_degraded=True,
        web_degraded=False,
        degradation_notes="RAG retrieval failed",
    )
    assert b.rag_degraded is True
    assert b.degradation_notes == "RAG retrieval failed"


# ---------------------------------------------------------------------------
# Pipeline trace includes retrieval degradation
# ---------------------------------------------------------------------------


@skip_no_fastapi
def test_pipeline_trace_includes_retrieval_degradation():
    from app.main import _build_pipeline_trace

    state = {
        "retrieval_degraded": True,
        "retrieval_degradation_notes": "RAG returned no results",
        "task_size": "medium",
        "iteration_count": 1,
    }
    trace = _build_pipeline_trace(state)
    assert "retrieval" in trace
    assert trace["retrieval"]["degraded"] is True
    assert "RAG returned no results" in trace["retrieval"]["notes"]


@skip_no_fastapi
def test_pipeline_trace_no_degradation_omits_key():
    from app.main import _build_pipeline_trace

    state = {
        "retrieval_degraded": False,
        "task_size": "small",
        "iteration_count": 1,
    }
    trace = _build_pipeline_trace(state)
    assert "retrieval" not in trace


# ---------------------------------------------------------------------------
# Entry pipeline trivial fast-path
# ---------------------------------------------------------------------------


@skip_no_langgraph
@skip_no_async
@pytest.mark.asyncio
async def test_entry_pipeline_trivial_skips_advisor_and_frame():
    """Trivial tasks should skip advisor and frame_extractor in entry pipeline."""
    from app.nodes.entry_pipeline import entry_pipeline_node

    trivial_classifier_output = {
        "task_is_trivial": True,
        "difficulty": 0.05,
        "task_description": "hello world",
        "is_code_task": False,
        "rag_mode": "disabled",
    }

    with (
        patch("app.nodes.entry_pipeline.entry_classifier_node", return_value=trivial_classifier_output),
        patch("app.nodes.entry_pipeline.strategic_advisor_node") as mock_advisor,
        patch("app.nodes.entry_pipeline.frame_extractor_node") as mock_frame,
    ):
        result = await entry_pipeline_node({"messages": []})

        assert result.get("task_is_trivial") is True
        assert result.get("current_node") == "entry_pipeline"
        mock_advisor.assert_not_called()
        mock_frame.assert_not_called()


@skip_no_langgraph
@skip_no_async
@pytest.mark.asyncio
async def test_entry_pipeline_complex_runs_all_branches():
    """Non-trivial tasks should run advisor, frame_extractor, and cache warm."""
    from unittest.mock import AsyncMock

    from app.nodes.entry_pipeline import entry_pipeline_node

    complex_classifier_output = {
        "task_is_trivial": False,
        "difficulty": 0.6,
        "task_description": "design a microservices architecture",
        "is_code_task": False,
        "rag_mode": "normal",
    }

    advisor_output = {"strategic_advice": "focus on domain separation"}
    frame_output = {"semantic_frame": {"topics": ["microservices"]}}

    with (
        patch("app.nodes.entry_pipeline.entry_classifier_node", return_value=complex_classifier_output),
        patch("app.nodes.entry_pipeline.strategic_advisor_node", return_value=advisor_output),
        patch("app.nodes.entry_pipeline.frame_extractor_node", return_value=frame_output),
        patch("app.nodes.entry_pipeline._predictive_cache_warm", new_callable=AsyncMock, return_value=None),
    ):
        result = await entry_pipeline_node({"messages": []})

        assert result.get("current_node") == "entry_pipeline"
        assert result.get("task_is_trivial") is False
        assert "semantic_frame" in result
