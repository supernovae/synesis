"""Tests for depth mode (parallel per-section generation).

Validates:
  - Activation logic (_should_activate_depth_mode)
  - Section result merging (_merge_section_results)
  - Section worker RAG query formulation
  - Writer pass budget scaling for depth mode
"""

from __future__ import annotations

import pytest

from app.nodes.planner_node import _should_activate_depth_mode
from app.nodes.section_worker import _build_section_rag_query, _format_rag_for_section
from app.state import _merge_section_results


class TestDepthModeActivation:
    """Verify _should_activate_depth_mode gating logic."""

    def _make_state(self, **overrides) -> dict:
        base = {
            "is_code_task": False,
            "task_size": "hard",
            "plan_required": True,
            "taxonomy_metadata": {"taxonomy_key": "software_architecture", "complexity_score": 0.8},
            "active_domain_refs": ["software_architecture"],
        }
        base.update(overrides)
        return base

    def _make_steps(self, n: int) -> list:
        return [{"id": i + 1, "action": f"Section {i + 1}"} for i in range(n)]

    def test_activates_for_hard_deep_dive_with_enough_steps(self, monkeypatch):
        monkeypatch.setenv("SYNESIS_DEPTH_MODE", "auto")
        state = self._make_state()
        steps = self._make_steps(5)
        assert _should_activate_depth_mode(state, steps) is True

    def test_disabled_mode_never_activates(self, monkeypatch):
        monkeypatch.setenv("SYNESIS_DEPTH_MODE", "disabled")
        from app.config import Settings
        s = Settings()
        monkeypatch.setattr("app.nodes.planner_node.settings", s)
        state = self._make_state()
        steps = self._make_steps(5)
        assert _should_activate_depth_mode(state, steps) is False

    def test_code_tasks_never_activate(self, monkeypatch):
        monkeypatch.setenv("SYNESIS_DEPTH_MODE", "auto")
        state = self._make_state(is_code_task=True)
        steps = self._make_steps(5)
        assert _should_activate_depth_mode(state, steps) is False

    def test_easy_tasks_dont_activate_in_auto(self, monkeypatch):
        monkeypatch.setenv("SYNESIS_DEPTH_MODE", "auto")
        state = self._make_state(task_size="easy")
        steps = self._make_steps(5)
        assert _should_activate_depth_mode(state, steps) is False

    def test_too_few_steps_dont_activate(self, monkeypatch):
        monkeypatch.setenv("SYNESIS_DEPTH_MODE", "auto")
        state = self._make_state()
        steps = self._make_steps(2)
        assert _should_activate_depth_mode(state, steps) is False

    def test_always_mode_activates_for_any_planned_task(self, monkeypatch):
        monkeypatch.setenv("SYNESIS_DEPTH_MODE", "always")
        from app.config import Settings
        s = Settings()
        monkeypatch.setattr("app.nodes.planner_node.settings", s)
        state = self._make_state(task_size="medium", taxonomy_metadata={"taxonomy_key": "general"})
        steps = self._make_steps(3)
        assert _should_activate_depth_mode(state, steps) is True


class TestSectionResultMerger:
    """Verify _merge_section_results reducer deduplicates and appends."""

    def test_empty_merge(self):
        result = _merge_section_results([], [])
        assert result == []

    def test_appends_new_sections(self):
        existing = [{"section_id": 1, "text": "Section 1"}]
        new = [{"section_id": 2, "text": "Section 2"}]
        result = _merge_section_results(existing, new)
        assert len(result) == 2
        assert result[0]["section_id"] == 1
        assert result[1]["section_id"] == 2

    def test_deduplicates_by_section_id(self):
        existing = [{"section_id": 1, "text": "Original"}]
        new = [{"section_id": 1, "text": "Duplicate"}, {"section_id": 2, "text": "New"}]
        result = _merge_section_results(existing, new)
        assert len(result) == 2
        assert result[0]["text"] == "Original"
        assert result[1]["section_id"] == 2

    def test_multiple_parallel_results_merge(self):
        batch1 = [{"section_id": 1, "text": "A"}]
        batch2 = [{"section_id": 2, "text": "B"}]
        batch3 = [{"section_id": 3, "text": "C"}]
        merged = _merge_section_results([], batch1)
        merged = _merge_section_results(merged, batch2)
        merged = _merge_section_results(merged, batch3)
        assert len(merged) == 3
        assert [s["section_id"] for s in merged] == [1, 2, 3]


class TestSectionRagQuery:
    """Verify per-section RAG query formulation."""

    def test_extracts_topic_from_action(self):
        query = _build_section_rag_query(
            "Section: Architecture — Propose a concrete architecture with component diagram",
            "Design an AI assistant",
        )
        assert "Architecture" in query
        assert "Design an AI assistant" in query

    def test_handles_simple_action(self):
        query = _build_section_rag_query("Explain failure modes", "Build a coding assistant")
        assert "Explain failure modes" in query

    def test_truncates_long_task_description(self):
        long_desc = "x" * 500
        query = _build_section_rag_query("Section: Intro", long_desc)
        assert len(query) < 300


class TestFormatRagForSection:
    """Verify RAG context formatting for section workers."""

    def test_empty_results(self):
        assert _format_rag_for_section([]) == ""

    def test_formats_with_authority(self):
        class MockResult:
            text = "Some RAG content about architecture"
            authority = "canonical"
            source_url = "https://example.com/doc"
        result = _format_rag_for_section([MockResult()])
        assert "[R:canonical]" in result
        assert "source: https://example.com/doc" in result
        assert "Some RAG content" in result
        assert '<context source="rag"' in result

    def test_caps_at_5_results(self):
        class MockResult:
            text = "Content"
            authority = ""
            source_url = ""
        results = [MockResult() for _ in range(10)]
        formatted = _format_rag_for_section(results)
        assert formatted.count("[R]") == 5
