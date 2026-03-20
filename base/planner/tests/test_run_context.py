"""run_context: critic turn kind and trace link computation."""

from __future__ import annotations

import pytest

from app.run_context import compute_trace_links, derive_critic_turn_kind


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
