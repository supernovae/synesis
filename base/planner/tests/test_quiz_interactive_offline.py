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
    pick_richer_conversation_transcript,
    prior_transcript_from_request_messages,
    reply_looks_like_quiz_letter_or_word_form,
    should_merge_short_followup_content,
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


class _Msg:
    def __init__(self, role: str, content: str) -> None:
        self.role = role
        self.content = content


def test_prior_transcript_includes_assistant_before_last_user():
    msgs = [
        _Msg("user", _CERT_STYLE_USER),
        _Msg("assistant", _QUIZ_ASSISTANT),
        _Msg("user", "b)"),
    ]
    prior = prior_transcript_from_request_messages(msgs)
    assert len(prior) == 2
    assert "CKA" in prior[0]
    assert "kubectl get pods -A" in prior[1]


def test_pick_richer_prefers_client_when_memory_truncated_or_empty():
    mem = ["[user]: short", "[assistant]: " + "x" * 100]
    client = ["[user]: " + _CERT_STYLE_USER, "[assistant]: " + _QUIZ_ASSISTANT]
    assert pick_richer_conversation_transcript(mem, client) == client
    assert pick_richer_conversation_transcript([], client) == client
    assert pick_richer_conversation_transcript(client, []) == client


def test_merge_letter_plus_option_word_over_48_chars():
    hist = [
        "[user]: Pick the best answer for TLS default port.",
        "[assistant]: A) 22 B) 80 C) 443 D) 8080",
    ]
    reply = "C) the secure port used for HTTPS traffic on the web (standard port 443)"
    assert len(reply) > 48
    merged = merge_short_followup_for_classification(reply, hist)
    assert "TLS" in merged
    assert "User follow-up:" in merged


def test_merge_option_word_only():
    hist = [
        "[user]: Vocabulary: which word fits the blank?",
        "[assistant]: Options: A) mundane B) eclectic C) dry",
    ]
    merged = merge_short_followup_for_classification("eclectic", hist)
    assert "eclectic" in merged
    assert "Vocabulary" in merged


def test_reply_looks_like_quiz_letter_word_form():
    assert reply_looks_like_quiz_letter_or_word_form("B) eclectic")
    assert reply_looks_like_quiz_letter_or_word_form("a) derivative")
    assert reply_looks_like_quiz_letter_or_word_form("C the narrow one")
    assert not reply_looks_like_quiz_letter_or_word_form("what is kubernetes")
    assert should_merge_short_followup_content("eclectic", short_len=48)
    assert should_merge_short_followup_content("B) something longer than forty-eight characters here", short_len=48)


def test_merge_b_with_client_only_transcript():
    """When L1 memory is empty, client transcript still enables quiz follow-up merge."""
    msgs = [
        _Msg("user", "Quiz me on ports; four options A–D."),
        _Msg("assistant", "Which is well-known HTTP? A) 22 B) 80 C) 443 D) 8080"),
        _Msg("user", "b)"),
    ]
    prior = prior_transcript_from_request_messages(msgs)
    merged = merge_short_followup_for_classification("b)", prior)
    assert "ports" in merged.lower() or "Quiz" in merged
    assert "User follow-up: b)" in merged
