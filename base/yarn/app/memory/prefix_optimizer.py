"""Ensure cache-optimal message ordering for prefix caching.

Both DeepInfra and vLLM APC cache from token 0 forward. Any divergence
in the prefix kills the cache hit. This module validates that messages
are correctly ordered and raises warnings on detected issues.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("yarn.memory.prefix")


def validate_prefix_order(messages: list[dict[str, Any]]) -> list[str]:
    """Check that messages follow the cache-optimal zone layout.

    Returns a list of warning strings (empty = all good).

    Expected order:
    1. system messages (pinned zone)
    2. user/assistant/tool messages (stable + delta zones)
    3. No system messages after the first non-system message
    """
    warnings: list[str] = []
    seen_non_system = False

    for i, msg in enumerate(messages):
        role = msg.get("role", "")
        if role == "system":
            if seen_non_system:
                warnings.append(f"Message {i}: system message after non-system message will break prefix cache")
        else:
            seen_non_system = True

    if not messages:
        warnings.append("Empty message list")
    elif messages[0].get("role") != "system":
        warnings.append("First message should be system (pinned zone)")

    return warnings


def compute_prefix_stability(
    prev_messages: list[dict[str, Any]],
    curr_messages: list[dict[str, Any]],
) -> dict[str, int]:
    """Compare two message lists and report prefix stability metrics.

    Returns:
        shared_messages: number of leading messages that are identical
        shared_tokens_estimate: rough token estimate of shared prefix
        divergence_index: index where messages first differ
    """
    shared = 0
    for p, c in zip(prev_messages, curr_messages):
        if p == c:
            shared += 1
        else:
            break

    return {
        "shared_messages": shared,
        "divergence_index": shared,
        "total_prev": len(prev_messages),
        "total_curr": len(curr_messages),
    }
