"""Offline contract tests for quiz / cert-style interactive follow-ups.

No LLM, network, or langgraph — validates merge, writer prompt shaping, history
serialization, and pending drift for multiple-choice and short answers.
"""

from __future__ import annotations

import pytest

from app.pending_drift import pending_reply_diverges
from app.short_followup_context import (
    TRIVIAL_WRITER_SYSTEM_BASE,
    build_trivial_writer_system_prompt,
    conversation_history_to_openai_messages,
    effective_user_query,
    merge_short_followup_for_classification,
)

# --- Typical user setup + assistant quiz block (vocabulary / cert style) ---

_CERT_STYLE_USER = (
    "I'm studying for the CKA. Give me one multiple-choice question about pods "
    "with four labeled options A–D and tell me you'll grade my answer next."
)

_QUIZ_ASSISTANT = """**Question 1**

Which kubectl command lists pods in all namespaces?

**Options**
- A) `kubectl get pods`
- B) `kubectl get pods -A`
- C) `kubectl describe pods`
- D) `kubectl list pods --all`

Reply with your choice (e.g. **B**)."""


@pytest.fixture
def cert_quiz_history() -> list[str]:
    return [f"[user]: {_CERT_STYLE_USER}", f"[assistant]: {_QUIZ_ASSISTANT}"]


@pytest.mark.parametrize(
    "reply",
    [
        "B",
        "b",
        "B.",
        "b)",
        " B ",
        "2",
        "42",
        "yes",
        "no",
        "correct",
        "incorrect",
    ],
)
def test_pending_drift_treats_quiz_replies_as_continuation(reply: str):
    pending = {"task_description": _CERT_STYLE_USER}
    assert pending_reply_diverges(pending, reply) is False


@pytest.mark.parametrize(
    "reply,expect_drift",
    [
        ("what is a pod in kubernetes", True),
        ("explain RBAC instead", True),
        ("forget that — new topic: helm", True),
    ],
)
def test_pending_drift_still_catches_new_questions(reply: str, expect_drift: bool):
    pending = {"task_description": _CERT_STYLE_USER}
    assert pending_reply_diverges(pending, reply) is expect_drift


@pytest.mark.parametrize(
    "followup",
    ["B", "A", " C ", "1", "yes"],
)
def test_merge_attaches_cert_style_prompt(cert_quiz_history: list[str], followup: str):
    out = merge_short_followup_for_classification(followup, cert_quiz_history)
    assert "CKA" in out
    assert "multiple-choice" in out.lower() or "choice" in out.lower()
    assert f"User follow-up: {followup.strip()}" in out


def test_merge_vocab_style_matches_user_scenario():
    hist = [
        "[user]: Help me study vocabulary: write a sentence for me to fill in the blank, "
        "and I'll pick the correct option.",
        "[assistant]: Sentence:\nThe river was ______.\n\nOptions:\nA) dry\nB) swollen\nC) narrow\nD) frozen",
    ]
    out = merge_short_followup_for_classification("B", hist)
    assert "vocabulary" in out
    assert "User follow-up: B" in out


def test_effective_user_query_prefers_merged_task_description():
    lu = "B"
    td = (
        "Help me study vocabulary: fill in the blank.\n\n(User follow-up: B)"
    )
    assert effective_user_query(lu, td) == td


def test_effective_user_query_unchanged_when_task_description_not_merged():
    q = "Explain Kubernetes services in two paragraphs."
    assert effective_user_query(q, q) == q


def test_trivial_system_includes_continuation_hint_only_with_history():
    bare = build_trivial_writer_system_prompt(False)
    with_hist = build_trivial_writer_system_prompt(True)
    assert bare == TRIVIAL_WRITER_SYSTEM_BASE
    assert "quiz" in with_hist.lower()
    assert "role-play" in with_hist.lower()
    assert len(with_hist) > len(bare)


def test_history_to_openai_preserves_quiz_options_block(cert_quiz_history: list[str]):
    msgs = conversation_history_to_openai_messages(cert_quiz_history)
    assert len(msgs) == 2
    assert msgs[0]["role"] == "user"
    assert "CKA" in msgs[0]["content"]
    assert msgs[1]["role"] == "assistant"
    assert "kubectl get pods -A" in msgs[1]["content"]
    assert "**Options**" in msgs[1]["content"] or "Options" in msgs[1]["content"]


def test_fast_stream_message_stack_shape(cert_quiz_history: list[str]):
    """Mirrors writer fast path: system + history + effective user content."""
    system = build_trivial_writer_system_prompt(True)
    hist_msgs = conversation_history_to_openai_messages(cert_quiz_history)
    lu, td = "B", merge_short_followup_for_classification("B", cert_quiz_history)
    user_block = effective_user_query(lu, td)
    stack = [{"role": "system", "content": system}, *hist_msgs, {"role": "user", "content": user_block}]
    assert stack[0]["role"] == "system"
    assert stack[-1]["role"] == "user"
    assert "CKA" in stack[-1]["content"]
    assert "User follow-up: B" in stack[-1]["content"]
    assert any("kubectl" in m["content"] for m in stack if m["role"] == "assistant")
