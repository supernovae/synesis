"""Tests for graph.py routing functions -- pure logic, no LLM calls needed.

These verify the conditional edges that determine which node runs next.
"""

from __future__ import annotations

from unittest.mock import patch

from app.graph import (
    respond_node,
    route_after_critic,
    route_after_executor,
    route_after_supervisor,
)


class TestRouteAfterSupervisor:
    def test_routes_to_worker(self):
        state = {"next_node": "worker"}
        assert route_after_supervisor(state) == "worker"

    def test_routes_to_respond_on_error(self):
        state = {"next_node": "worker", "error": "something broke"}
        assert route_after_supervisor(state) == "respond"

    def test_routes_to_respond_by_default(self):
        state = {"next_node": "respond"}
        assert route_after_supervisor(state) == "respond"

    def test_routes_to_respond_on_missing_next(self):
        state = {}
        assert route_after_supervisor(state) == "respond"


class TestRouteAfterExecutor:
    @patch("app.graph.settings")
    def test_success_routes_to_critic(self, mock_settings):
        mock_settings.lsp_enabled = False
        mock_settings.max_iterations = 3
        state = {"execution_exit_code": 0}
        assert route_after_executor(state) == "critic"

    @patch("app.graph.settings")
    def test_none_exit_code_routes_to_critic(self, mock_settings):
        mock_settings.lsp_enabled = False
        mock_settings.max_iterations = 3
        state = {"execution_exit_code": None}
        assert route_after_executor(state) == "critic"

    @patch("app.graph.settings")
    def test_error_routes_to_respond(self, mock_settings):
        mock_settings.lsp_enabled = False
        state = {"error": "crash", "execution_exit_code": 1}
        assert route_after_executor(state) == "respond"

    @patch("app.graph.settings")
    def test_failure_with_lsp_on_failure(self, mock_settings):
        mock_settings.lsp_enabled = True
        mock_settings.lsp_mode = "on_failure"
        mock_settings.max_iterations = 3
        state = {"execution_exit_code": 1, "iteration_count": 1}
        assert route_after_executor(state) == "lsp_analyzer"

    @patch("app.graph.settings")
    def test_failure_with_lsp_always(self, mock_settings):
        """In 'always' mode, LSP already ran pre-execution, so skip to worker."""
        mock_settings.lsp_enabled = True
        mock_settings.lsp_mode = "always"
        mock_settings.max_iterations = 3
        state = {"execution_exit_code": 1, "iteration_count": 1}
        assert route_after_executor(state) == "worker"

    @patch("app.graph.settings")
    def test_failure_without_lsp(self, mock_settings):
        mock_settings.lsp_enabled = False
        mock_settings.max_iterations = 3
        state = {"execution_exit_code": 1, "iteration_count": 1}
        assert route_after_executor(state) == "worker"

    @patch("app.graph.settings")
    def test_failure_at_max_iterations(self, mock_settings):
        mock_settings.lsp_enabled = True
        mock_settings.lsp_mode = "on_failure"
        mock_settings.max_iterations = 3
        state = {"execution_exit_code": 1, "iteration_count": 3}
        assert route_after_executor(state) == "respond"


class TestRouteAfterCritic:
    @patch("app.graph.settings")
    def test_approved_routes_to_respond(self, mock_settings):
        mock_settings.max_iterations = 3
        state = {"critic_approved": True}
        assert route_after_critic(state) == "respond"

    @patch("app.graph.settings")
    def test_not_approved_routes_to_supervisor(self, mock_settings):
        mock_settings.max_iterations = 3
        state = {"critic_approved": False, "iteration_count": 1}
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
    def test_with_code(self):
        state = {
            "generated_code": "echo hello",
            "code_explanation": "prints greeting",
            "target_language": "bash",
            "node_traces": [],
            "what_if_analyses": [],
        }
        result = respond_node(state)
        msgs = result["messages"]
        assert len(msgs) == 1
        assert "echo hello" in msgs[0].content
        assert "bash" in msgs[0].content

    def test_with_error(self):
        state = {
            "error": "timeout occurred",
            "generated_code": "",
            "node_traces": [],
            "what_if_analyses": [],
        }
        result = respond_node(state)
        assert "issue" in result["messages"][0].content.lower()
        assert "timeout" in result["messages"][0].content.lower()

    def test_empty_state(self):
        state = {}
        result = respond_node(state)
        assert result["current_node"] == "respond"
        assert len(result["messages"]) == 1
