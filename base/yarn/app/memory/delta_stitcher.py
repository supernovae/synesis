"""Incremental context extension — attention-sink token management.

The delta stitcher ensures that the pinned zone (system prompt, tool defs,
memory replay) remains byte-identical across requests. It also manages the
boundary between stable and delta zones for optimal prefix caching.
"""

from __future__ import annotations

from typing import Any

from ..context.reducer import build_user_turn_content
from .buffer import MemoryBuffer, count_message_tokens


def stitch_delta(
    buf: MemoryBuffer,
    new_user_content: str,
    tools: list[dict[str, Any]] | None = None,
    system_prompt: str | None = None,
    memory_replay: str | None = None,
) -> list[dict[str, Any]]:
    """Prepare a cache-optimized context by appending a delta to the buffer.

    The pinned zone is set once and never changes (maximum cache hit).
    The stable zone grows monotonically. The new user message is the
    only cache miss.

    Returns the full context ready for model consumption.
    """
    if system_prompt is not None and not buf._pinned:
        buf.set_system_prompt(system_prompt)

    if tools is not None:
        buf.set_tool_definitions(tools)

    if memory_replay is not None:
        buf.set_memory_replay(memory_replay)

    buf.append_user(build_user_turn_content(new_user_content, None))
    return buf.get_context()


def estimate_cache_hit_tokens(buf: MemoryBuffer) -> int:
    """Estimate how many tokens will be a prefix-cache hit on the next request.

    Everything in pinned + stable (minus the last user message) is shared
    with the previous request and should be a cache hit.
    """
    total = buf._pinned_tokens

    if buf._stable:
        last_msg_tokens = count_message_tokens(buf._stable[-1])
        total += max(0, buf._stable_tokens - last_msg_tokens)

    return total
