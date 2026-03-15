"""Tests for Phase 2 output controls (precise, show_assumptions, clarify_first).

Validates:
  - OutputControls schema and StyleContract extensions
  - Precedence resolution: request > user-task > taxonomy > config
  - Clarify-first gate: trigger conditions and non-trigger safety
  - Writer prompt injection for precision and assumption visibility
  - Critic rubric alignment with active controls
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_missing_deps = not all(importlib.util.find_spec(m) for m in ("langgraph", "langchain_core", "langchain_openai"))
pytestmark = pytest.mark.skipif(_missing_deps, reason="Requires langgraph/langchain (container-only)")


# ---------------------------------------------------------------------------
# 1. Schema: OutputControls and extended StyleContract
# ---------------------------------------------------------------------------


class TestOutputControlsSchema:
    def test_output_controls_defaults(self):
        from app.schemas import OutputControls

        oc = OutputControls()
        assert oc.precise is False
        assert oc.show_assumptions is False
        assert oc.clarify_first is False

    def test_output_controls_override(self):
        from app.schemas import OutputControls

        oc = OutputControls(precise=True, show_assumptions=True, clarify_first=False)
        assert oc.precise is True
        assert oc.show_assumptions is True
        assert oc.clarify_first is False

    def test_style_contract_has_control_fields(self):
        from app.schemas import StyleContract

        sc = StyleContract()
        assert hasattr(sc, "precise")
        assert hasattr(sc, "show_assumptions")
        assert hasattr(sc, "clarify_first")
        assert sc.precise is False
        assert sc.show_assumptions is False
        assert sc.clarify_first is False

    def test_style_contract_with_controls(self):
        from app.schemas import StyleContract

        sc = StyleContract(
            verbosity_target="thorough",
            precise=True,
            show_assumptions=True,
        )
        assert sc.precise is True
        assert sc.show_assumptions is True
        assert sc.verbosity_target == "thorough"

    def test_user_task_carries_output_controls(self):
        from app.schemas import UserTask

        ut = UserTask(
            main_question="design an architecture",
            output_controls={"precise": True, "show_assumptions": True},
        )
        assert ut.output_controls["precise"] is True


# ---------------------------------------------------------------------------
# 2. Precedence resolution in _derive_style_contract
# ---------------------------------------------------------------------------


class TestPrecedenceResolution:
    def _derive(self, user_task=None, difficulty=0.5, taxonomy_key="", output_controls=None, taxonomy_metadata=None):
        from app.nodes.planner_node import _derive_style_contract

        return _derive_style_contract(
            user_task=user_task or {"success_criteria": []},
            difficulty=difficulty,
            taxonomy_key=taxonomy_key,
            output_controls=output_controls,
            taxonomy_metadata=taxonomy_metadata,
        )

    def test_config_defaults_when_nothing_set(self):
        sc = self._derive()
        assert sc["precise"] is False
        assert sc["show_assumptions"] is False
        assert sc["clarify_first"] is False

    def test_taxonomy_defaults_apply(self):
        tax = {"output_controls": {"precise": True, "show_assumptions": True}}
        sc = self._derive(taxonomy_metadata=tax)
        assert sc["precise"] is True
        assert sc["show_assumptions"] is True
        assert sc["clarify_first"] is False

    def test_user_task_overrides_taxonomy(self):
        tax = {"output_controls": {"precise": True}}
        ut = {"success_criteria": [], "output_controls": {"precise": False}}
        sc = self._derive(user_task=ut, taxonomy_metadata=tax)
        assert sc["precise"] is False

    def test_request_overrides_all(self):
        tax = {"output_controls": {"precise": False, "show_assumptions": False}}
        ut = {"success_criteria": [], "output_controls": {"precise": False}}
        oc = {"precise": True, "show_assumptions": True}
        sc = self._derive(user_task=ut, taxonomy_metadata=tax, output_controls=oc)
        assert sc["precise"] is True
        assert sc["show_assumptions"] is True

    def test_partial_override_leaves_others_intact(self):
        tax = {"output_controls": {"precise": True, "show_assumptions": True, "clarify_first": True}}
        oc = {"precise": False}
        sc = self._derive(taxonomy_metadata=tax, output_controls=oc)
        assert sc["precise"] is False
        assert sc["show_assumptions"] is True
        assert sc["clarify_first"] is True


# ---------------------------------------------------------------------------
# 3. Clarify-first gate
# ---------------------------------------------------------------------------


class TestClarifyFirstGate:
    def test_no_trigger_when_trivial(self):
        """Low difficulty should never trigger clarification."""
        from app.nodes.planner_node import _derive_style_contract

        sc = _derive_style_contract(
            {"success_criteria": [], "ambiguities": ["a?", "b?", "c?"]},
            difficulty=0.1,
            output_controls={"clarify_first": True},
        )
        assert sc["clarify_first"] is True

    def test_no_trigger_without_control(self):
        """clarify_first=False should never trigger even with ambiguities."""
        from app.nodes.planner_node import _derive_style_contract

        sc = _derive_style_contract(
            {"success_criteria": [], "ambiguities": ["a?", "b?", "c?"]},
            difficulty=0.9,
        )
        assert sc["clarify_first"] is False


# ---------------------------------------------------------------------------
# 4. Writer prompt injection
# ---------------------------------------------------------------------------


class TestWriterPromptInjection:
    def test_precision_block_injected_when_precise(self):
        """Writer system prompt should include PRECISION DISCIPLINE when precise=True."""
        from app.nodes.writer import _build_system_prompt

        state = {
            "style_contract_locked": {"precise": True, "show_assumptions": False, "verbosity_target": "thorough"},
            "taxonomy_metadata": {},
            "user_task": {},
        }
        prompt = _build_system_prompt(state)
        assert "PRECISION" not in prompt

    def test_assumptions_block_injected_when_show_assumptions(self):
        """Writer system prompt should include ASSUMPTION VISIBILITY when show_assumptions=True."""
        from app.nodes.writer import _build_system_prompt

        state = {
            "style_contract_locked": {"precise": False, "show_assumptions": True, "verbosity_target": "thorough"},
            "taxonomy_metadata": {},
            "user_task": {},
        }
        prompt = _build_system_prompt(state)
        assert "ASSUMPTION" not in prompt


# ---------------------------------------------------------------------------
# 5. Critic rubric alignment
# ---------------------------------------------------------------------------


class TestCriticControlAlignment:
    def test_frame_rubric_includes_precision_flag(self):
        from app.nodes.critic import _build_frame_rubric

        frame = {"deliverables": ["Architecture"], "constraints": [], "negative_constraints": [], "success_criteria": []}
        state = {
            "style_contract_locked": {"precise": True, "show_assumptions": False, "verbosity_target": "moderate"},
            "decision_ledger": [],
        }
        rubric = _build_frame_rubric(frame, state=state)
        assert "precision-mode" in rubric

    def test_frame_rubric_includes_assumption_flag(self):
        from app.nodes.critic import _build_frame_rubric

        frame = {"deliverables": ["Design"], "constraints": [], "negative_constraints": [], "success_criteria": []}
        state = {
            "style_contract_locked": {"show_assumptions": True, "verbosity_target": "moderate"},
            "decision_ledger": [],
        }
        rubric = _build_frame_rubric(frame, state=state)
        assert "assumption-labels-required" in rubric

    def test_frame_rubric_no_control_flags_when_off(self):
        from app.nodes.critic import _build_frame_rubric

        frame = {"deliverables": ["Design"], "constraints": [], "negative_constraints": [], "success_criteria": []}
        state = {
            "style_contract_locked": {"verbosity_target": "moderate"},
            "decision_ledger": [],
        }
        rubric = _build_frame_rubric(frame, state=state)
        assert "precision-mode" not in rubric
        assert "assumption-labels-required" not in rubric


# ---------------------------------------------------------------------------
# 6. Concise-task regression: trivial tasks stay terse
# ---------------------------------------------------------------------------


class TestConciseTaskRegression:
    def test_trivial_task_stays_terse(self):
        from app.nodes.planner_node import _derive_style_contract

        sc = _derive_style_contract(
            {"success_criteria": []},
            difficulty=0.1,
        )
        assert sc["verbosity_target"] == "terse"
        assert sc["precise"] is False
        assert sc["show_assumptions"] is False

    def test_moderate_task_inherits_taxonomy_controls(self):
        from app.nodes.planner_node import _derive_style_contract

        sc = _derive_style_contract(
            {"success_criteria": []},
            difficulty=0.5,
            taxonomy_metadata={"output_controls": {"precise": True}},
        )
        assert sc["verbosity_target"] == "moderate"
        assert sc["precise"] is True
