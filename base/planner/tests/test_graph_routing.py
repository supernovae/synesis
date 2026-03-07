"""Tests for graph.py routing functions -- pure logic, no LLM calls needed.

These verify the conditional edges that determine which node runs next.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from app.graph import (
    respond_node,
    route_after_critic,
    route_after_entry_classifier,
    route_after_patch_integrity_gate,
    route_after_planner,
    route_after_supervisor,
    route_after_worker,
)


class TestRouteAfterEntryClassifier:
    def test_no_pending_routes_to_supervisor(self):
        """Default path: no trivial, no pending → Supervisor."""
        assert route_after_entry_classifier({}) == "supervisor"

    def test_pending_question_continue_routes_by_source(self):
        state = {"pending_question_continue": True, "pending_question_source": "worker"}
        assert route_after_entry_classifier(state) == "context_curator"

        state["pending_question_source"] = "supervisor"
        assert route_after_entry_classifier(state) == "supervisor"

    def test_pending_plan_routes_via_context_curator(self):
        """Planner/Worker source routes through context curator before worker."""
        state = {"pending_question_continue": True, "pending_question_source": "planner"}
        assert route_after_entry_classifier(state) == "context_curator"

    def test_trivial_routes_to_context_curator(self):
        """Easy fast path: bypass Supervisor."""
        state = {"task_size": "easy", "bypass_supervisor": True}
        assert route_after_entry_classifier(state) == "context_curator"

    def test_ui_helper_routes_to_respond(self):
        state = {"message_origin": "ui_helper"}
        assert route_after_entry_classifier(state) == "respond"


class TestRouteAfterWorker:
    def test_needs_input_routes_to_respond(self):
        state = {"needs_input_question": "Which database?"}
        assert route_after_worker(state) == "respond"

    def test_stop_reason_routes_to_respond(self):
        for reason in ("blocked_external", "cannot_reproduce", "unsafe_request"):
            state = {"stop_reason": reason}
            assert route_after_worker(state) == "respond"

    def test_needs_scope_expansion_routes_to_supervisor(self):
        state = {"stop_reason": "needs_scope_expansion"}
        assert route_after_worker(state) == "supervisor"

    def test_has_code_routes_to_patch_integrity_gate(self):
        state = {}
        assert route_after_worker(state) == "patch_integrity_gate"


class TestRouteAfterPatchIntegrityGate:
    def test_fail_routes_to_context_curator(self):
        """Gate fail routes through context_curator before worker."""
        state = {"integrity_passed": False}
        assert route_after_patch_integrity_gate(state) == "context_curator"

    def test_pass_routes_to_critic(self):
        state = {"integrity_passed": True}
        assert route_after_patch_integrity_gate(state) == "critic"

    def test_default_pass_routes_to_critic(self):
        state = {}
        assert route_after_patch_integrity_gate(state) == "critic"


class TestRouteAfterPlanner:
    """Planner never ends the graph — always continues to context_curator or respond."""

    def test_no_approval_routes_to_context_curator(self):
        """Default: plan auto-proceeds to context_curator → worker."""
        state = {"plan_pending_approval": False}
        assert route_after_planner(state) == "context_curator"

    def test_plan_approval_routes_to_respond(self):
        """When plan needs approval, surface to user; user replies to continue."""
        state = {"plan_pending_approval": True}
        assert route_after_planner(state) == "respond"

    def test_missing_plan_pending_defaults_to_continue(self):
        """Missing plan_pending_approval treated as False → context_curator."""
        state = {}
        assert route_after_planner(state) == "context_curator"

    def test_never_returns_planner(self):
        """Invariant: we never 'end' at planner; always context_curator or respond."""
        for pending in (True, False):
            out = route_after_planner({"plan_pending_approval": pending})
            assert out in ("context_curator", "respond"), f"plan_pending={pending} → {out}"


class TestRouteAfterSupervisor:
    def test_routes_to_worker(self):
        """Supervisor→worker path goes via context_curator (RAG) first; graph has no direct supervisor→worker edge."""
        state = {"next_node": "worker"}
        assert route_after_supervisor(state) == "context_curator"

    def test_routes_to_planner(self):
        state = {"next_node": "planner"}
        assert route_after_supervisor(state) == "planner"

    def test_routes_to_respond_on_error(self):
        state = {"next_node": "worker", "error": "something broke"}
        assert route_after_supervisor(state) == "respond"

    def test_routes_to_respond_by_default(self):
        state = {"next_node": "respond"}
        assert route_after_supervisor(state) == "respond"

    def test_routes_to_respond_on_missing_next(self):
        state = {}
        assert route_after_supervisor(state) == "respond"


class TestRouteAfterCritic:
    @patch("app.graph.settings")
    def test_approved_routes_to_respond(self, mock_settings):
        mock_settings.max_iterations = 3
        state = {"critic_approved": True}
        assert route_after_critic(state) == "respond"

    @patch("app.graph.settings")
    def test_not_approved_routes_to_supervisor(self, mock_settings):
        """Critic not approved + should_continue → supervisor for revision (critic sets both when not approved)."""
        mock_settings.max_iterations = 3
        state = {
            "critic_approved": False,
            "critic_should_continue": True,
            "iteration_count": 1,
        }
        assert route_after_critic(state) == "supervisor"

    @patch("app.graph.settings")
    def test_not_approved_at_max_iterations(self, mock_settings):
        mock_settings.max_iterations = 3
        state = {"critic_approved": False, "iteration_count": 3}
        assert route_after_critic(state) == "respond"

    @patch("app.graph.settings")
    def test_error_routes_to_respond(self, mock_settings):
        state = {"error": "boom", "critic_approved": False}
        assert route_after_critic(state) == "respond"

    @patch("app.graph.settings")
    def test_default_approved_true(self, mock_settings):
        """critic_approved defaults to True (missing key), so route to respond."""
        mock_settings.max_iterations = 3
        state = {}
        assert route_after_critic(state) == "respond"


class TestRespondNode:
    @pytest.mark.asyncio
    async def test_with_code(self):
        state = {
            "generated_code": "echo hello",
            "code_explanation": "prints greeting",
            "target_language": "bash",
            "node_traces": [],
            "what_if_analyses": [],
        }
        result = await respond_node(state)
        msgs = result["messages"]
        assert len(msgs) == 1
        assert "echo hello" in msgs[0].content
        assert "bash" in msgs[0].content

    @pytest.mark.asyncio
    async def test_with_error(self):
        state = {
            "error": "timeout occurred",
            "generated_code": "",
            "node_traces": [],
            "what_if_analyses": [],
        }
        result = await respond_node(state)
        assert "issue" in result["messages"][0].content.lower()
        assert "timeout" in result["messages"][0].content.lower()

    @pytest.mark.asyncio
    async def test_empty_state(self):
        state = {}
        result = await respond_node(state)
        assert result["current_node"] == "respond"
        assert len(result["messages"]) == 1

    @pytest.mark.asyncio
    async def test_stop_reason_surfaces_message(self):
        state = {
            "stop_reason": "blocked_external",
            "stop_reason_explanation": "Need API key for external service.",
            "generated_code": "",
        }
        result = await respond_node(state)
        content = result["messages"][0].content
        assert "cannot proceed" in content.lower()
        assert "dependency" in content.lower() or "credential" in content.lower()
        assert "API key" in content

    def test_no_teach_mode_chunks_injected(self):
        """Teach mode removed: no invariant_teach_mode chunks should exist."""
        from app.nodes.context_curator import _build_pinned_context

        chunks = _build_pinned_context(
            task_type="explain",
            target_language="markdown",
            task_description="Explain X",
            execution_plan={},
            org_standards=[],
            project_manifest=[],
            session_preferences={"is_code_task": False},
        )
        teach_chunks = [c for c in chunks if c.doc_id == "invariant_teach_mode"]
        assert len(teach_chunks) == 0
