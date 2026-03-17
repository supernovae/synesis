"""Sanitize step actions from the planner before injection into downstream prompts.

Step actions originate from the planner LLM, which processes user input.
A crafted user message could cause the planner to emit step text that acts
as an indirect injection payload when pasted into the writer/executor prompt.
"""

from __future__ import annotations

import re

_MAX_ACTION_LEN = 300

_ACTION_INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?", re.IGNORECASE),
    re.compile(r"new\s+instructions?\s*:", re.IGNORECASE),
    re.compile(r"override\s+(?:your\s+)?(?:instructions?|prompt)", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+(?:a|an)\s", re.IGNORECASE),
    re.compile(r"system\s*:\s*", re.IGNORECASE),
    re.compile(r"<\|im_start\|>", re.IGNORECASE),
    re.compile(r"\[INST\]", re.IGNORECASE),
]


def sanitize_step_action(action: str) -> str:
    """Return the action string, truncated and injection-checked.

    If the text matches known injection patterns the offending portion is
    replaced with '[redacted]' so the outline still conveys intent without
    carrying the payload.
    """
    action = action[:_MAX_ACTION_LEN]
    for pat in _ACTION_INJECTION_PATTERNS:
        action = pat.sub("[redacted]", action)
    return action
