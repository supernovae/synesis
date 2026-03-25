"""run_context: critic turn kind, trace links, and trace context budget/failure."""

from __future__ import annotations

from app.run_context import build_trace_context, compute_trace_links, derive_critic_turn_kind


def test_derive_interactive_continue():
    s = {"pending_question_continue": True, "pending_question_source": "planner_clarification"}
    assert derive_critic_turn_kind(s) == "interactive_continue"


def test_derive_final():
    assert derive_critic_turn_kind({}) == "final"


def test_compute_trace_links_no_pending():
    p, r, tr = compute_trace_links(run_id="a", conversation_id="c1", pending=None)
    assert p is None
    assert r == "a"
    assert tr == "a"


def test_compute_trace_links_with_pending():
    pending = {"origin_run_id": "parent-1", "root_trace_id": "root-1"}
    p, r, tr = compute_trace_links(run_id="child", conversation_id="c1", pending=pending)
    assert p == "parent-1"
    assert r == "root-1"
    assert tr == "root-1"


def test_build_trace_context_budget_and_failure_fields():
    ctx = build_trace_context(
        {
            "token_budget_remaining": 0,
            "current_node": "critic",
            "error": "Node timed out while evaluating",
        }
    )
    assert ctx["token_budget_state"] in {"healthy", "degraded", "exhausted"}
    assert isinstance(ctx["budget_exhausted"], bool)
    assert ctx["failure_stage"] == "critic"
    assert ctx["failure_type"] in {"budget_exhausted", "timeout"}
    assert "timed out" in ctx["failure_reason"].lower()
