"""Message origin detection and UI-helper filtering.

Prevents OpenWebUI follow-ups, suggested prompts, and other non-end-user
messages from reaching the Supervisor/coding workflow.
"""

from __future__ import annotations

import re
from typing import Literal

MessageOrigin = Literal["end_user", "ui_helper", "system_test", "internal_tool"]
UIHelperType = Literal["title", "tags", "follow_ups", "generic"]

_TITLE_PATTERNS = [
    re.compile(r"###\s*Task:\s*Generate\s+.*title\s+with\s+emoji", re.IGNORECASE),
    re.compile(r"generate\s+a\s+concise.*title", re.IGNORECASE),
    re.compile(r"concise.*\d[- ]?\d?\s*word\s+title", re.IGNORECASE),
]

_TAG_PATTERNS = [
    re.compile(r"###\s*Task:\s*Generate\s+.*broad\s+tags", re.IGNORECASE),
    re.compile(r"generate\s+\d[- ]?\d?\s+broad\s+tags", re.IGNORECASE),
]

_FOLLOW_UP_PATTERNS = [
    re.compile(
        r"suggest\s+(3[- ]?5\s+)?(relevant\s+)?follow[- ]?up\s+questions?",
        re.IGNORECASE,
    ),
    re.compile(r"generate\s+(3[- ]?5\s+)?follow[- ]?ups?", re.IGNORECASE),
    re.compile(r"output\s+must\s+be\s+(a\s+)?JSON\s+array\s+of\s+followups?", re.IGNORECASE),
    re.compile(r"###\s*Task:\s*Suggest\s+.*follow[- ]?up", re.IGNORECASE),
    re.compile(r'"follow_ups"\s*:\s*\[', re.IGNORECASE),
    re.compile(r"Response must be a JSON array of strings", re.IGNORECASE),
    re.compile(r"your entire response must consist solely of the JSON", re.IGNORECASE),
]

_ALL_UI_HELPER_PATTERNS = _TITLE_PATTERNS + _TAG_PATTERNS + _FOLLOW_UP_PATTERNS


def classify_ui_helper_type(content: str) -> UIHelperType | None:
    """Classify the sub-type of a UI helper message. Returns None for end-user messages."""
    if not content or not content.strip():
        return None
    text = content.strip()[:800]
    for pat in _TITLE_PATTERNS:
        if pat.search(text):
            return "title"
    for pat in _TAG_PATTERNS:
        if pat.search(text):
            return "tags"
    for pat in _FOLLOW_UP_PATTERNS:
        if pat.search(text):
            return "follow_ups"
    return None


def classify_message_origin(content: str) -> MessageOrigin:
    """Classify message origin. UI-helper prompts are routed away from coding workflow."""
    if classify_ui_helper_type(content) is not None:
        return "ui_helper"
    return "end_user"


def is_ui_helper_message(content: str) -> bool:
    """Quick check: should this message be rejected from the main graph?"""
    return classify_message_origin(content) == "ui_helper"
