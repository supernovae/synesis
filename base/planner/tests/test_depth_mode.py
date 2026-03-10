"""Tests for depth mode (parallel per-section generation).

Validates:
  - Activation logic (_should_activate_depth_mode)
  - Section result merging (_merge_section_results)
  - Evidence gatherer RAG query formulation (via query_distiller)
  - Context block formatting
"""

from __future__ import annotations

from app.context_formatter import format_context_block
from app.nodes.planner_node import _should_activate_depth_mode
from app.query_distiller import distill_from_frame, distill_query, distill_web_from_frame
from app.state import _merge_section_results


def _build_section_queries(
    section_action: str,
    task_description: str,
    user_task: dict,
) -> tuple[str, str]:
    """Build RAG and web queries — mirrors evidence_gatherer's use of query_distiller."""
    if user_task and user_task.get("main_question"):
        rag_query = distill_from_frame(section_action, user_task)
        web_query = distill_web_from_frame(section_action, user_task)
    else:
        rag_query = distill_query(section_action, task_description)
        web_query = rag_query[:80]
    return rag_query, web_query


class TestDepthModeActivation:
    """Verify _should_activate_depth_mode gating logic.

    Depth mode activates for all non-code tasks with 2+ plan steps.
    Only disabled for code tasks or when depth_mode config = "disabled".
    """

    def _make_state(self, **overrides) -> dict:
        base = {
            "is_code_task": False,
            "plan_required": True,
            "taxonomy_metadata": {"taxonomy_key": "software_architecture", "complexity_score": 0.8},
            "active_domain_refs": ["software_architecture"],
        }
        base.update(overrides)
        return base

    def _make_steps(self, n: int) -> list:
        return [{"id": i + 1, "action": f"Section {i + 1}"} for i in range(n)]

    def test_activates_for_knowledge_with_enough_steps(self, monkeypatch):
        monkeypatch.setenv("SYNESIS_DEPTH_MODE", "auto")
        state = self._make_state()
        steps = self._make_steps(5)
        assert _should_activate_depth_mode(state, steps) is True

    def test_activates_with_just_two_steps(self, monkeypatch):
        """Minimum 2 steps triggers depth mode for non-code tasks."""
        monkeypatch.setenv("SYNESIS_DEPTH_MODE", "auto")
        state = self._make_state()
        steps = self._make_steps(2)
        assert _should_activate_depth_mode(state, steps) is True

    def test_disabled_mode_never_activates(self, monkeypatch):
        monkeypatch.setenv("SYNESIS_DEPTH_MODE", "disabled")
        from importlib import import_module

        from app.config import Settings

        pn_mod = import_module("app.nodes.planner_node")
        monkeypatch.setattr(pn_mod, "settings", Settings())
        state = self._make_state()
        steps = self._make_steps(5)
        assert _should_activate_depth_mode(state, steps) is False

    def test_code_tasks_never_activate(self, monkeypatch):
        monkeypatch.setenv("SYNESIS_DEPTH_MODE", "auto")
        state = self._make_state(is_code_task=True)
        steps = self._make_steps(5)
        assert _should_activate_depth_mode(state, steps) is False

    def test_single_step_does_not_activate(self, monkeypatch):
        """Fewer than 2 steps → no depth mode."""
        monkeypatch.setenv("SYNESIS_DEPTH_MODE", "auto")
        state = self._make_state()
        steps = self._make_steps(1)
        assert _should_activate_depth_mode(state, steps) is False

    def test_always_mode_activates_for_any_planned_task(self, monkeypatch):
        monkeypatch.setenv("SYNESIS_DEPTH_MODE", "always")
        from importlib import import_module

        from app.config import Settings

        pn_mod = import_module("app.nodes.planner_node")
        monkeypatch.setattr(pn_mod, "settings", Settings())
        state = self._make_state(taxonomy_metadata={"taxonomy_key": "general"})
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
    """Verify per-section RAG query formulation (evidence_gatherer uses query_distiller)."""

    def test_extracts_topic_from_action_with_frame(self):
        frame = {"problem": "Design an AI assistant", "deliverables": ["architecture diagram"], "domain": "software"}
        rag_q, web_q = _build_section_queries(
            "Section: Architecture — Propose a concrete architecture with component diagram",
            "Design an AI assistant",
            frame,
        )
        assert len(rag_q) > 0
        assert len(web_q) > 0

    def test_fallback_without_frame(self):
        rag_q, _web_q = _build_section_queries(
            "Explain failure modes",
            "Build a coding assistant",
            {},
        )
        assert "failure" in rag_q.lower() or "coding" in rag_q.lower()

    def test_returns_tuple(self):
        result = _build_section_queries("Section: Intro", "Build something", {})
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_no_word_echo_in_web_query(self):
        """Web query should not repeat the same word 3+ times (the echo-chamber bug)."""
        frame = {
            "problem": "Design a production-ready AI assistant for an engineering organization",
            "deliverables": [
                "Main design goals",
                "Concrete architecture proposal",
                "Explanation of model choices",
                "Explanation of retrieval mechanism",
                "Description of failure modes and mitigations",
            ],
            "constraints": ["Team size: 80 engineers", "Budget is limited", "Must support Kubernetes and Python"],
            "domain": "software_architecture",
        }
        _rag_q, web_q = _build_section_queries(
            "Section: Explanation of model choices — discuss small vs large models",
            "Design a production-ready AI assistant",
            frame,
        )
        words = web_q.lower().split()
        from collections import Counter

        counts = Counter(words)
        for word, count in counts.items():
            assert count < 3, f"Word '{word}' appears {count} times in web query: {web_q}"


class TestFormatContextBlock:
    """Verify RAG context formatting via format_context_block."""

    def test_empty_results(self):
        assert format_context_block([]) == ""

    def test_formats_with_authority(self):
        class MockResult:
            text = "Some RAG content about architecture"
            authority = "canonical"
            source_url = "https://example.com/doc"
            heading_path = ""
            document_name = ""
            chunk_summary = ""
            retrieval_source = "rag"
            is_trusted = True

        result = format_context_block([MockResult()])
        assert "[R:canonical]" in result
        assert "source: https://example.com/doc" in result
        assert "Some RAG content" in result
        assert '<context trust="untrusted"' in result

    def test_formats_multiple_results(self):
        results = [
            {
                "text": f"Content {i}",
                "authority": "",
                "source_url": "",
                "heading_path": "",
                "document_name": "",
                "chunk_summary": "",
                "retrieval_source": "rag",
                "is_trusted": False,
            }
            for i in range(5)
        ]
        formatted = format_context_block(results)
        assert formatted.count("[R]") == 5
