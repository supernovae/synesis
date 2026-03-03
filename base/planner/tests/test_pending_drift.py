"""Tests for pending_reply_diverges — avoid wrong resume when reply is a new question."""

import pytest

from ..app.pending_drift import pending_reply_diverges


def test_knowledge_style_diverges():
    """Knowledge-style questions (what is, how does) should diverge from plan approval pending."""
    pending = {
        "task_description": "create a marathon training plan for intermediate runner",
        "expected_answer_types": ["confirm", "approve"],
        "execution_plan": {"steps": [{"action": "Create basic structure"}]},
    }
    assert pending_reply_diverges(pending, "what is the speed of light") is True
    assert pending_reply_diverges(pending, "what is VO2max") is True
    assert pending_reply_diverges(pending, "how does photosynthesis work") is True
    assert pending_reply_diverges(pending, "explain quantum entanglement") is True
    assert pending_reply_diverges(pending, "define homeostasis") is True


def test_confirm_does_not_diverge():
    """Short confirmations should NOT diverge."""
    pending = {
        "task_description": "create a marathon training plan",
        "expected_answer_types": ["confirm"],
    }
    assert pending_reply_diverges(pending, "yes") is False
    assert pending_reply_diverges(pending, "ok proceed") is False
    assert pending_reply_diverges(pending, "sounds good") is False
