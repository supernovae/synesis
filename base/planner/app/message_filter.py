"""Message origin detection and UI-helper filtering.

Prevents OpenWebUI follow-ups, suggested prompts, and other non-end-user
messages from reaching the Supervisor/coding workflow.
"""

from __future__ import annotations

import re
from typing import Literal

MessageOrigin = Literal["end_user", "ui_helper", "system_test", "internal_tool"]

# Meta-instructions from UI plugins (OpenWebUI follow-ups, title/tag generators, etc.)
_UI_HELPER_PATTERNS = [
    re.compile(
        r"suggest\s+(3[- ]?5\s+)?(relevant\s+)?follow[- ]?up\s+questions?",
        re.IGNORECASE,
    ),
    re.compile(r"generate\s+(3[- ]?5\s+)?follow[- ]?ups?", re.IGNORECASE),
    re.compile(r"output\s+must\s+be\s+(a\s+)?JSON\s+array\s+of\s+followups?", re.IGNORECASE),
    re.compile(r"###\s*Task:\s*Suggest\s+.*follow[- ]?up", re.IGNORECASE),
    re.compile(r"###\s*Task:\s*Generate\s+.*title\s+with\s+emoji", re.IGNORECASE),
    re.compile(r"###\s*Task:\s*Generate\s+.*broad\s+tags", re.IGNORECASE),
    re.compile(r'"follow_ups"\s*:\s*\[', re.IGNORECASE),
    re.compile(r"Response must be a JSON array of strings", re.IGNORECASE),
    re.compile(r"your entire response must consist solely of the JSON", re.IGNORECASE),
]


def classify_message_origin(content: str) -> MessageOrigin:
    """Classify message origin. UI-helper prompts are routed away from coding workflow."""
    if not content or not content.strip():
        return "end_user"
    text = content.strip()[:800]
    for pat in _UI_HELPER_PATTERNS:
        if pat.search(text):
            return "ui_helper"
    return "end_user"


def is_ui_helper_message(content: str) -> bool:
    """Quick check: should this message be rejected from the main graph?"""
    return classify_message_origin(content) == "ui_helper"
