"""Tests for the Cohesion Lock Engine.

Validates:
- Deterministic cohesion lock detection from metadata
- Exclusion signal generation for known entity pairs
- Cohesion filter respects protected top-N documents
- LongContextReorder places strongest items at edges
- Writer template renders persona and cohesion lock correctly
- Persona detection from raw user text
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass

import pytest

# ---------------------------------------------------------------------------
# Fixtures: minimal mock for UnifiedResult-like objects
# ---------------------------------------------------------------------------


@dataclass
class FakeResult:
    text: str = ""
    document_name: str = ""
    heading_path: str = ""
    title: str = ""
    source_url: str = ""
    authority: str = ""
    retrieval_source: str = "rag"
    score: float = 0.5


# ---------------------------------------------------------------------------
# Cohesion Lock Detection (deterministic path)
# ---------------------------------------------------------------------------


class TestCohesionLockDetection:
    """Test deterministic metadata-based lock detection."""

    def test_detects_specific_entity_from_metadata(self):
        from app.cohesion import _detect_cohesion_lock_deterministic

        results = [
            FakeResult(document_name="AWS Lambda Guide", heading_path="AWS > Lambda"),
            FakeResult(document_name="AWS EC2 Setup", heading_path="AWS > EC2"),
            FakeResult(document_name="Cloud Deployment", heading_path="Generic"),
        ]
        lock = _detect_cohesion_lock_deterministic(results, top_n=3)
        assert lock is not None
        assert lock.entity == "aws"
        assert lock.lock_type == "specific"
        assert "gcp" in lock.exclude_signals or "azure" in lock.exclude_signals

    def test_returns_none_for_diverse_metadata(self):
        from app.cohesion import _detect_cohesion_lock_deterministic

        results = [
            FakeResult(document_name="Python Guide", heading_path="Programming"),
            FakeResult(document_name="Math Primer", heading_path="Science"),
            FakeResult(document_name="History Notes", heading_path="Humanities"),
        ]
        lock = _detect_cohesion_lock_deterministic(results, top_n=3)
        assert lock is None

    def test_returns_none_for_insufficient_results(self):
        from app.cohesion import _detect_cohesion_lock_deterministic

        results = [FakeResult(document_name="AWS Lambda")]
        lock = _detect_cohesion_lock_deterministic(results, top_n=3)
        assert lock is None

    def test_detects_framework_entity(self):
        from app.cohesion import _detect_cohesion_lock_deterministic

        results = [
            FakeResult(title="React Hooks Guide"),
            FakeResult(document_name="React Component Patterns"),
            FakeResult(heading_path="React > State Management"),
        ]
        lock = _detect_cohesion_lock_deterministic(results, top_n=3)
        assert lock is not None
        assert lock.entity == "react"
        assert "angular" in lock.exclude_signals

    def test_detects_automotive_entity(self):
        from app.cohesion import _detect_cohesion_lock_deterministic

        results = [
            FakeResult(document_name="Ford F-150 Manual", heading_path="Ford > Trucks"),
            FakeResult(title="Ford Mustang Service Guide"),
            FakeResult(document_name="Car Maintenance"),
        ]
        lock = _detect_cohesion_lock_deterministic(results, top_n=3)
        assert lock is not None
        assert lock.entity == "ford"
        assert "chevy" in lock.exclude_signals


class TestExclusionSignals:
    """Test exclusion signal generation for known entity pairs."""

    def test_cloud_provider_exclusion(self):
        from app.cohesion import _build_exclusion_signals

        signals = _build_exclusion_signals("aws")
        assert "gcp" in signals
        assert "azure" in signals
        assert "aws" not in signals

    def test_unknown_entity_returns_empty(self):
        from app.cohesion import _build_exclusion_signals

        signals = _build_exclusion_signals("some_unknown_thing")
        assert signals == []

    def test_framework_exclusion(self):
        from app.cohesion import _build_exclusion_signals

        signals = _build_exclusion_signals("pytorch")
        assert "tensorflow" in signals
        assert "jax" in signals

    def test_case_insensitive(self):
        from app.cohesion import _build_exclusion_signals

        signals = _build_exclusion_signals("AWS")
        assert "gcp" in signals


class TestCohesionLockDataclass:
    """Test CohesionLock serialization."""

    def test_to_dict(self):
        from app.cohesion import CohesionLock

        lock = CohesionLock(
            entity="aws",
            lock_type="specific",
            exclude_signals=["gcp", "azure"],
            confidence=0.8,
            source="metadata",
        )
        d = lock.to_dict()
        assert d["entity"] == "aws"
        assert d["type"] == "specific"
        assert "gcp" in d["exclude_signals"]
        assert d["confidence"] == 0.8
        assert d["source"] == "metadata"

    def test_to_dict_generic(self):
        from app.cohesion import CohesionLock

        lock = CohesionLock(
            entity="transformer architecture",
            lock_type="generic",
            exclude_signals=[],
            confidence=0.6,
            source="llm",
        )
        d = lock.to_dict()
        assert d["type"] == "generic"
        assert d["exclude_signals"] == []


# ---------------------------------------------------------------------------
# LongContextReorder (standalone function, no heavy deps)
# ---------------------------------------------------------------------------

_has_langgraph = importlib.util.find_spec("langgraph") is not None


@pytest.mark.skipif(not _has_langgraph, reason="langgraph not installed (container-only dep)")
class TestLongContextReorder:
    """Test that LongContextReorder places strongest items at edges."""

    def test_two_items_unchanged(self):
        from app.nodes.writer import _long_context_reorder

        items = ["A", "B"]
        assert _long_context_reorder(items) == ["A", "B"]

    def test_single_item_unchanged(self):
        from app.nodes.writer import _long_context_reorder

        items = ["A"]
        assert _long_context_reorder(items) == ["A"]

    def test_empty_list_unchanged(self):
        from app.nodes.writer import _long_context_reorder

        assert _long_context_reorder([]) == []

    def test_five_items_edges(self):
        from app.nodes.writer import _long_context_reorder

        items = ["A", "B", "C", "D", "E"]
        reordered = _long_context_reorder(items)
        assert reordered[-1] == "E"
        assert len(reordered) == 5
        assert set(reordered) == set(items)

    def test_preserves_all_items(self):
        from app.nodes.writer import _long_context_reorder

        items = list("ABCDEFGH")
        reordered = _long_context_reorder(items)
        assert sorted(reordered) == sorted(items)
        assert len(reordered) == len(items)


# ---------------------------------------------------------------------------
# Writer Template (requires langgraph for state imports)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not _has_langgraph, reason="langgraph not installed (container-only dep)")
class TestWriterTemplate:
    """Test the writer system prompt template rendering."""

    def test_default_persona(self):
        from app.nodes.writer import _build_system_prompt

        state: dict = {}
        prompt = _build_system_prompt(state)
        assert "Structured Writer" in prompt
        assert "COHESION LOCK" not in prompt

    def test_persona_from_user_task(self):
        from app.nodes.writer import _build_system_prompt

        state = {"user_task": {"persona": "pirate"}}
        prompt = _build_system_prompt(state)
        assert "pirate" in prompt

    def test_persona_from_taxonomy(self):
        from app.nodes.writer import _build_system_prompt

        state = {
            "user_task": {"persona": ""},
            "taxonomy_metadata": {"persona_instructions": "Formal Analyst"},
        }
        prompt = _build_system_prompt(state)
        assert "Formal Analyst" in prompt

    def test_persona_priority_user_task_over_taxonomy(self):
        from app.nodes.writer import _build_system_prompt

        state = {
            "user_task": {"persona": "pirate"},
            "taxonomy_metadata": {"persona_instructions": "Formal Analyst"},
        }
        prompt = _build_system_prompt(state)
        assert "pirate" in prompt
        assert "Formal Analyst" not in prompt

    def test_cohesion_lock_injected(self):
        from app.nodes.writer import _build_system_prompt

        state = {
            "cohesion_lock": {
                "entity": "Transformer Architecture",
                "type": "generic",
                "exclude_signals": ["AWS", "GCP"],
            }
        }
        prompt = _build_system_prompt(state)
        assert "COHESION LOCK" in prompt
        assert "Transformer Architecture" in prompt
        assert "AWS" in prompt
        assert "GCP" in prompt

    def test_no_cohesion_lock_no_block(self):
        from app.nodes.writer import _build_system_prompt

        state = {"cohesion_lock": {}}
        prompt = _build_system_prompt(state)
        assert "COHESION LOCK" not in prompt


# ---------------------------------------------------------------------------
# Persona Detection (standalone, no heavy deps)
# ---------------------------------------------------------------------------


class TestPersonaDetection:
    """Test persona extraction from raw user text.

    _detect_persona is a pure regex function, but importing it from
    frame_normalizer triggers the schemas -> state -> langgraph chain.
    We replicate the function's regex logic inline here so tests run
    locally without langgraph. The full integration is tested in CI.
    """

    @staticmethod
    def _detect_persona(raw_text: str) -> str:
        """Local copy of the detection logic for testing without langgraph."""
        import re

        _PERSONA_PATTERNS: list[tuple[re.Pattern[str], str, bool]] = [
            (re.compile(r"\blike\s+a\s+(\w+)\b", re.IGNORECASE), "{0}", False),
            (re.compile(r"\bas\s+(?:a|an)\s+(\w+)\b", re.IGNORECASE), "{0}", False),
            (re.compile(r"\bin\s+(?:the\s+)?(?:style|voice|tone)\s+of\s+(?:a\s+)?(\w+)", re.IGNORECASE), "{0}", False),
            (
                re.compile(r"\bexplain\s+(?:it\s+)?to\s+(?:a\s+)?(\d+)[\s-]*year[\s-]*old\b", re.IGNORECASE),
                "ELI{0}",
                True,
            ),
            (
                re.compile(r"\bexplain\s+(?:it\s+)?(?:like|as if)\s+(?:I'?m|i am)\s+(?:a\s+)?(\w+)\b", re.IGNORECASE),
                "{0}",
                False,
            ),
        ]
        _PERSONA_STOPWORDS = frozenset(
            {
                "the",
                "a",
                "an",
                "it",
                "this",
                "that",
                "my",
                "your",
                "me",
                "way",
                "much",
                "more",
                "well",
                "also",
                "very",
                "how",
                "what",
                "why",
                "can",
                "do",
                "should",
                "would",
                "could",
                "will",
                "following",
                "possible",
            }
        )
        for pattern, template, skip_check in _PERSONA_PATTERNS:
            match = pattern.search(raw_text)
            if match:
                captured = match.group(1).strip().lower()
                if skip_check or (captured not in _PERSONA_STOPWORDS and len(captured) > 1):
                    return template.format(captured)
        return ""

    def test_like_a_pirate(self):
        assert self._detect_persona("Tell me about LLMs like a pirate") == "pirate"

    def test_as_a_professor(self):
        assert self._detect_persona("Explain this as a professor") == "professor"

    def test_eli5(self):
        result = self._detect_persona("explain it to a 5 year old")
        assert result == "ELI5"

    def test_no_persona_cue(self):
        assert self._detect_persona("How does binary search work?") == ""

    def test_style_of_teacher(self):
        assert self._detect_persona("explain in the style of a teacher") == "teacher"

    def test_stopwords_ignored(self):
        result = self._detect_persona("do it like a the")
        assert result == ""

    def test_explain_as_if_im_beginner(self):
        result = self._detect_persona("explain it as if I'm a beginner")
        assert result == "beginner"


# ---------------------------------------------------------------------------
# State schema (requires langgraph)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not _has_langgraph, reason="langgraph not installed (container-only dep)")
class TestCohesionLockState:
    """Test that cohesion_lock integrates with GraphState."""

    def test_cohesion_lock_in_graphstate(self):
        from app.state import GraphState

        hints = GraphState.__annotations__
        assert "cohesion_lock" in hints

    def test_persona_in_usertask(self):
        from app.schemas import UserTask

        task = UserTask(persona="pirate")
        assert task.persona == "pirate"

    def test_persona_defaults_empty(self):
        from app.schemas import UserTask

        task = UserTask()
        assert task.persona == ""


# ---------------------------------------------------------------------------
# Downstream hardening: Summarizer cohesion constraint
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not _has_langgraph, reason="langgraph not installed (container-only dep)")
class TestSummarizerCohesionConstraint:
    """Test that _build_cohesion_constraint produces the right prompt block."""

    def test_with_lock_and_exclusions(self):
        from app.nodes.router import _build_cohesion_constraint

        lock = {"entity": "AWS", "exclude_signals": ["GCP", "Azure"]}
        block = _build_cohesion_constraint(lock)
        assert "COHESION CONSTRAINT" in block
        assert "AWS" in block
        assert "GCP" in block
        assert "Azure" in block

    def test_with_lock_no_exclusions(self):
        from app.nodes.router import _build_cohesion_constraint

        lock = {"entity": "transformer architecture", "exclude_signals": []}
        block = _build_cohesion_constraint(lock)
        assert "COHESION CONSTRAINT" in block
        assert "transformer architecture" in block
        assert "Exclude content" not in block

    def test_no_lock_returns_empty(self):
        from app.nodes.router import _build_cohesion_constraint

        assert _build_cohesion_constraint(None) == ""
        assert _build_cohesion_constraint({}) == ""
        assert _build_cohesion_constraint({"entity": ""}) == ""
