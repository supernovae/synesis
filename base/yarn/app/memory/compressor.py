"""Turn summarization for long sessions.

When the memory buffer evicts turns, the compressor summarizes them into a
compact "memory replay" message that gets pinned. This preserves context
while keeping the pinned zone byte-stable across requests.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("yarn.memory.compressor")

SUMMARIZE_SYSTEM_PROMPT = (
    "You are a conversation summarizer. Given evicted conversation turns, "
    "produce a concise summary preserving key decisions, code references, "
    "file paths, variable names, and any unresolved tasks. "
    "Output ONLY the summary, no preamble."
)


def build_summarize_messages(
    evicted_turns: list[dict[str, Any]],
    existing_replay: str = "",
) -> list[dict[str, Any]]:
    """Build a message list for the summarization call.

    Returns messages suitable for passing to the model executor.
    The caller is responsible for actually invoking the model.
    """
    content_parts: list[str] = []

    if existing_replay:
        content_parts.append(f"Previous session context:\n{existing_replay}\n")

    content_parts.append("Evicted conversation turns to incorporate:\n")
    for turn in evicted_turns:
        role = turn.get("role", "unknown")
        text = turn.get("content", "")
        if turn.get("tool_calls"):
            calls = ", ".join(tc.get("function", {}).get("name", "?") for tc in turn["tool_calls"])
            text += f" [tool_calls: {calls}]"
        content_parts.append(f"  [{role}]: {text[:500]}")

    return [
        {"role": "system", "content": SUMMARIZE_SYSTEM_PROMPT},
        {"role": "user", "content": "\n".join(content_parts)},
    ]


def merge_replay(existing_replay: str, new_summary: str) -> str:
    """Merge an existing replay summary with new summary text.

    The result replaces the pinned memory-replay message.
    """
    if not existing_replay:
        return new_summary
    return f"{existing_replay}\n---\n{new_summary}"
