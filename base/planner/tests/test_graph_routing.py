"""Tests for graph.py routing functions -- pure logic, no LLM calls needed.

These verify the conditional edges that determine which node runs next.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (container-only)")

from app.graph import (
    respond_node,
    route_after_critic,
    route_after_entry_pipeline,
    route_after_executor,
    route_after_patch_integrity_gate,
    route_after_planner,
    route_after_router,
    route_after_writer,
)


class TestRouteAfterEntryPipeline:
    def test_default_routes_to_router(self):
        assert route_after_entry_pipeline({}) == "router"

    def test_pending_question_routes_to_router(self):
        state = {"pending_question_continue": True}
        assert route_after_entry_pipeline(state) == "router"

    def test_ui_helper_routes_to_respond(self):
        state = {"message_origin": "ui_helper"}
        assert route_after_entry_pipeline(state) == "respond"

    def test_trivial_non_code_routes_to_writer(self):
        state = {"task_is_trivial": True, "is_code_task": False}
        assert route_after_entry_pipeline(state) == "writer"

    def test_trivial_code_routes_to_executor(self):
        state = {"task_is_trivial": True, "is_code_task": True}
        assert route_after_entry_pipeline(state) == "executor"


class TestRouteAfterRouter:
    def test_error_routes_to_respond(self):
        state = {"error": "something broke"}
        assert route_after_router(state) == "respond"

    def test_next_node_planner(self):
        state = {"next_node": "planner"}
        assert route_after_router(state) == "planner"

    def test_next_node_writer(self):
        state = {"next_node": "writer"}
        assert route_after_router(state) == "writer"

    def test_next_node_executor(self):
        state = {"next_node": "executor"}
        assert route_after_router(state) == "executor"

    def test_default_routes_to_planner(self):
        assert route_after_router({}) == "planner"

    def test_invalid_next_node_defaults_to_planner(self):
        state = {"next_node": "nonexistent"}
        assert route_after_router(state) == "planner"


class TestRouteAfterPlanner:
    def test_plan_approval_routes_to_respond(self):
        state = {"plan_pending_approval": True}
        assert route_after_planner(state) == "respond"

    def test_no_approval_routes_to_router(self):
        state = {"plan_pending_approval": False}
        assert route_after_planner(state) == "router"

    def test_default_routes_to_router(self):
        assert route_after_planner({}) == "router"

    def test_planner_errors_with_plan_routes_to_router(self):
        state = {
            "planner_error_count": 3,
            "execution_plan": {"steps": [{"id": 1, "action": "test"}]},
        }
        assert route_after_planner(state) == "router"

    def test_planner_errors_without_plan_routes_to_respond(self):
        state = {"planner_error_count": 3, "execution_plan": {}}
        assert route_after_planner(state) == "respond"

    def test_evidence_requests_routes_to_router(self):
        state = {"evidence_requests": [{"description": "need more"}]}
        assert route_after_planner(state) == "router"


class TestRouteAfterExecutor:
    def test_needs_input_routes_to_respond(self):
        state = {"needs_input_question": "Which database?"}
        assert route_after_executor(state) == "respond"

    def test_stop_reason_routes_to_respond(self):
        state = {"stop_reason": "blocked_external"}
        assert route_after_executor(state) == "respond"

    def test_code_task_routes_to_patch_gate(self):
        state = {"is_code_task": True}
        assert route_after_executor(state) == "patch_integrity_gate"

    def test_non_code_routes_to_respond(self):
        assert route_after_executor({}) == "respond"


class TestRouteAfterWriter:
    @patch("app.graph.settings")
    def test_background_critic_routes_to_scrubber(self, mock_settings):
        mock_settings.critic_background = True
        assert route_after_writer({}) == "final_scrubber"

    @patch("app.graph.settings")
    def test_low_difficulty_routes_to_scrubber(self, mock_settings):
        mock_settings.critic_background = False
        mock_settings.critic_skip_below_difficulty = 0.3
        state = {"difficulty": 0.1}
        assert route_after_writer(state) == "final_scrubber"

    @patch("app.graph.settings")
    def test_high_difficulty_routes_to_critic(self, mock_settings):
        mock_settings.critic_background = False
        mock_settings.critic_skip_below_difficulty = 0.3
        state = {"difficulty": 0.8}
        assert route_after_writer(state) == "critic"


class TestRouteAfterPatchIntegrityGate:
    def test_fail_routes_to_router(self):
        state = {"integrity_passed": False}
        assert route_after_patch_integrity_gate(state) == "router"

    def test_pass_routes_to_critic(self):
        state = {"integrity_passed": True}
        assert route_after_patch_integrity_gate(state) == "critic"

    def test_default_routes_to_critic(self):
        assert route_after_patch_integrity_gate({}) == "critic"


class TestRouteAfterCritic:
    @patch("app.graph.settings")
    def test_approved_routes_to_scrubber(self, mock_settings):
        mock_settings.max_iterations = 3
        mock_settings.oscillation_threshold = 0.7
        state = {"critic_approved": True}
        assert route_after_critic(state) == "final_scrubber"

    @patch("app.graph.settings")
    def test_not_approved_needs_evidence_routes_to_router(self, mock_settings):
        mock_settings.max_iterations = 3
        mock_settings.oscillation_threshold = 0.7
        state = {
            "critic_approved": False,
            "need_more_evidence": True,
            "critic_should_continue": True,
            "iteration_count": 1,
        }
        assert route_after_critic(state) == "router"

    @patch("app.graph.settings")
    def test_not_approved_writing_quality_routes_to_writer(self, mock_settings):
        mock_settings.max_iterations = 3
        mock_settings.oscillation_threshold = 0.7
        state = {
            "critic_approved": False,
            "need_more_evidence": False,
            "critic_should_continue": True,
            "iteration_count": 1,
        }
        assert route_after_critic(state) == "writer"

    @patch("app.graph.settings")
    def test_max_iterations_routes_to_scrubber(self, mock_settings):
        mock_settings.max_iterations = 3
        mock_settings.oscillation_threshold = 0.7
        state = {"critic_approved": False, "iteration_count": 3}
        assert route_after_critic(state) == "final_scrubber"

    @patch("app.graph.settings")
    def test_error_routes_to_respond(self, mock_settings):
        state = {"error": "boom", "critic_approved": False}
        assert route_after_critic(state) == "respond"

    @patch("app.graph.settings")
    def test_default_approved_routes_to_scrubber(self, mock_settings):
        mock_settings.max_iterations = 3
        mock_settings.oscillation_threshold = 0.7
        assert route_after_critic({}) == "final_scrubber"


class TestRespondNode:
    @pytest.mark.asyncio
    async def test_with_code(self):
        state = {
            "generated_code": "echo hello",
            "code_explanation": "prints greeting",
            "target_language": "bash",
            "is_code_task": True,
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
