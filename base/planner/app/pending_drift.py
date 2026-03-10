"""Pending question drift detection — avoid wrong resume when reply diverges.

When user replies to a pending question (plan approval, needs_input, clarification),
check if the reply looks like a continuation or a new task. If drift detected,
treat as new task instead of resuming.
"""

from __future__ import annotations

import re
from typing import Any

# Strong drift signals: reply changes direction or starts new task
_DRIFT_PHRASES = re.compile(
    r"\b(forget that|instead,? |actually,? i want|one more thing|wait,? |hold on|"
    r"different task|new task|scratch that|never mind|start over)\b",
    re.IGNORECASE,
)
# Confirm-like: short affirmative (plan approval, needs_input)
_CONFIRM_PATTERN = re.compile(
    r"^(yes|yep|ok|okay|sure|proceed|go ahead|sounds good|looks good|correct|approved|fine|good)[\s\!\.]*$",
    re.IGNORECASE,
)
# Knowledge-style: clearly a new question, not a reply to plan/approval
_KNOWLEDGE_STYLE = re.compile(
    r"^(what is|what are|what was|how much|how many|when did|who was|who is|"
    r"explain |define |describe |tell me about|why does|why do |how does |how do )",
    re.IGNORECASE,
)


def pending_reply_diverges(pending: dict[str, Any], reply: str) -> bool:
    """Return True if reply likely diverges from pending task — treat as new task.

    Heuristics:
    - reply starts with knowledge-style phrase (what is, how does, explain) → drift
    - expected_answer_types includes "confirm" and reply is long non-confirm → drift
    - reply contains strong drift phrases (forget that, instead, scratch that) → drift
    - reply 2x+ task length with drift phrases → drift
    """
    reply = (reply or "").strip()
    if not reply:
        return False

    # Knowledge-style questions are clearly new requests, not plan approval
    if _KNOWLEDGE_STYLE.match(reply):
        return True

    task_desc = (pending.get("task_description") or "").strip()
    expected = pending.get("expected_answer_types") or []

    # Answer-type: expected short confirm but got long paragraph
    if "confirm" in expected or "approve" in expected:
        if len(reply) > 80 and not _CONFIRM_PATTERN.match(reply):
            return True

    # Strong drift phrases: user changing direction
    if _DRIFT_PHRASES.search(reply):
        return True

    # Reply 2x+ task length with drift signals
    return bool(task_desc and len(reply) >= 2 * len(task_desc) and len(reply) > 150)
