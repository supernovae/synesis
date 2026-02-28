"""Tests for graph.py routing functions -- pure logic, no LLM calls needed.

These verify the conditional edges that determine which node runs next.
"""

from __future__ import annotations

from unittest.mock import patch

from app.graph import (
    respond_node,
    route_after_critic,
    route_after_entry_classifier,
    route_after_patch_integrity_gate,
    route_after_sandbox,
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
        """Trivial fast path: bypass Supervisor."""
        state = {"task_size": "trivial", "bypass_supervisor": True}
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
        state = {"integrity_passed": False, "next_node": "sandbox"}
        assert route_after_patch_integrity_gate(state) == "context_curator"

    def test_pass_routes_by_next_node(self):
        state = {"integrity_passed": True, "next_node": "sandbox"}
        assert route_after_patch_integrity_gate(state) == "sandbox"

        state["next_node"] = "lsp_analyzer"
        assert route_after_patch_integrity_gate(state) == "lsp_analyzer"

    def test_default_pass_routes_to_sandbox(self):
        state = {}
        assert route_after_patch_integrity_gate(state) == "sandbox"


class TestRouteAfterSupervisor:
    def test_routes_to_worker(self):
        state = {"next_node": "worker"}
        assert route_after_supervisor(state) == "worker"

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


class TestRouteAfterSandbox:
    @patch("app.graph.settings")
    def test_success_routes_to_critic(self, mock_settings):
        mock_settings.lsp_enabled = False
        mock_settings.max_iterations = 3
        state = {"execution_exit_code": 0}
        assert route_after_sandbox(state) == "critic"

    @patch("app.graph.settings")
    def test_none_exit_code_routes_to_critic(self, mock_settings):
        mock_settings.lsp_enabled = False
        mock_settings.max_iterations = 3
        state = {"execution_exit_code": None}
        assert route_after_sandbox(state) == "critic"

    @patch("app.graph.settings")
    def test_error_routes_to_respond(self, mock_settings):
        mock_settings.lsp_enabled = False
        state = {"error": "crash", "execution_exit_code": 1}
        assert route_after_sandbox(state) == "respond"

    @patch("app.graph.settings")
    def test_failure_with_lsp_on_failure(self, mock_settings):
        mock_settings.lsp_enabled = True
        mock_settings.lsp_mode = "on_failure"
        mock_settings.max_iterations = 3
        state = {"execution_exit_code": 1, "iteration_count": 1}
        assert route_after_sandbox(state) == "lsp_analyzer"

    @patch("app.graph.settings")
    def test_failure_with_lsp_always(self, mock_settings):
        """In 'always' mode, LSP already ran pre-execution, route to context_curator→worker."""
        mock_settings.lsp_enabled = True
        mock_settings.lsp_mode = "always"
        mock_settings.max_iterations = 3
        state = {"execution_exit_code": 1, "iteration_count": 1}
        assert route_after_sandbox(state) == "context_curator"

    @patch("app.graph.settings")
    def test_failure_without_lsp(self, mock_settings):
        """Sandbox failure routes through context_curator before worker (re-curate on retry)."""
        mock_settings.lsp_enabled = False
        mock_settings.max_iterations = 3
        state = {"execution_exit_code": 1, "iteration_count": 1}
        assert route_after_sandbox(state) == "context_curator"

    @patch("app.graph.settings")
    def test_failure_at_max_iterations(self, mock_settings):
        """At max iterations, route to critic (postmortem) not respond."""
        mock_settings.lsp_enabled = True
        mock_settings.lsp_mode = "on_failure"
        mock_settings.max_iterations = 3
        state = {"execution_exit_code": 1, "iteration_count": 3}
        assert route_after_sandbox(state) == "critic"

    @patch("app.graph.settings")
    def test_trivial_runtime_breaks_loop_after_one_retry(self, mock_settings):
        """Trivial+runtime: first failure → context_curator; second (iteration>=1) → critic."""
        mock_settings.lsp_enabled = True
        mock_settings.lsp_mode = "on_failure"
        mock_settings.max_iterations = 3
        state = {
            "execution_exit_code": 1,
            "iteration_count": 1,
            "task_size": "trivial",
            "failure_type": "runtime",
            "execution_lint_passed": True,
            "execution_security_passed": True,
        }
        assert route_after_sandbox(state) == "critic"

        state["iteration_count"] = 0
        assert route_after_sandbox(state) == "context_curator"

    @patch("app.graph.settings")
    def test_next_node_critic_honors_same_failure_short_circuit(self, mock_settings):
        """When sandbox sets next_node=critic (same_failure_repeated), route to critic."""
        mock_settings.lsp_enabled = True
        mock_settings.lsp_mode = "on_failure"
        mock_settings.max_iterations = 3
        # Without next_node we would route to lsp_analyzer or context_curator
        state = {
            "execution_exit_code": 1,
            "iteration_count": 1,
            "failure_type": "runtime",
            "execution_lint_passed": True,
            "execution_security_passed": True,
            "next_node": "critic",
        }
        assert route_after_sandbox(state) == "critic"


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

    def test_stop_reason_surfaces_message(self):
        state = {
            "stop_reason": "blocked_external",
            "stop_reason_explanation": "Need API key for external service.",
            "generated_code": "",
        }
        result = respond_node(state)
        content = result["messages"][0].content
        assert "cannot proceed" in content.lower()
        assert "dependency" in content.lower() or "credential" in content.lower()
        assert "API key" in content

    def test_learners_corner_formatted_when_present(self):
        """Educational mode: Learner's Corner section when learners_corner in state."""
        state = {
            "generated_code": "print('hi')",
            "code_explanation": "Prints greeting.",
            "target_language": "python",
            "learners_corner": {
                "pattern": "Procedural",
                "why": "Simple output, no abstraction needed.",
                "resilience": "Responding: print() handles encoding.",
                "trade_off": "Verbosity for readability.",
            },
            "node_traces": [],
            "what_if_analyses": [],
        }
        result = respond_node(state)
        content = result["messages"][0].content
        assert "Learner's Corner" in content
        assert "Pattern:" in content
        assert "Procedural" in content
        assert "Why:" in content
        assert "Trade-off:" in content
