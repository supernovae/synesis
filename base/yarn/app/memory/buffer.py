"""Yarn-style rolling memory buffer with three-zone cache-optimized layout.

Layout:
  [PINNED ZONE]  system prompt + tool schemas + memory replay  (never evicted)
  [STABLE ZONE]  completed turns, appended monotonically       (high cache hit)
  [DELTA ZONE]   current user message                          (cache miss)

The buffer never reorders messages. Each new turn appends to the stable zone,
so every request shares a growing byte-identical prefix with the previous one.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from ..context.reducer import wrap_tool_result_content

logger = logging.getLogger("yarn.memory")

_encoder: Any = None


def _get_encoder() -> Any:
    global _encoder
    if _encoder is None:
        try:
            import tiktoken

            _encoder = tiktoken.get_encoding("cl100k_base")
        except Exception:
            _encoder = None
    return _encoder


def count_tokens(text: str) -> int:
    enc = _get_encoder()
    if enc is not None:
        return len(enc.encode(text))
    # Fallback heuristic: ~4 chars per token (GPT/Qwen average)
    return max(1, len(text) // 4)


def count_message_tokens(msg: dict[str, Any]) -> int:
    """Approximate token count for a chat message dict."""
    total = 4  # role overhead
    for key in ("content", "name", "tool_call_id"):
        val = msg.get(key)
        if val:
            total += count_tokens(str(val))
    if msg.get("tool_calls"):
        for tc in msg["tool_calls"]:
            fn = tc.get("function", {})
            total += count_tokens(fn.get("name", ""))
            total += count_tokens(fn.get("arguments", ""))
    return total


@dataclass
class MemoryBuffer:
    """Three-zone rolling memory buffer.

    Designed for prefix-cache efficiency: pinned messages are immutable,
    stable messages grow monotonically, and only the delta zone changes.
    """

    max_tokens: int = 131072
    pinned_budget: int = 8192

    # Zones
    _pinned: list[dict[str, Any]] = field(default_factory=list)
    _stable: list[dict[str, Any]] = field(default_factory=list)

    # Token accounting
    _pinned_tokens: int = 0
    _stable_tokens: int = 0

    # Eviction callback
    _evicted_turns: list[dict[str, Any]] = field(default_factory=list)
    _last_eviction: float = 0.0

    # --- Pinned Zone ---

    def set_system_prompt(self, content: str) -> None:
        """Set or replace the system prompt (first pinned message)."""
        msg = {"role": "system", "content": content}
        tokens = count_message_tokens(msg)

        if self._pinned and self._pinned[0].get("role") == "system":
            old_tokens = count_message_tokens(self._pinned[0])
            self._pinned[0] = msg
            self._pinned_tokens += tokens - old_tokens
        else:
            self._pinned.insert(0, msg)
            self._pinned_tokens += tokens

    def set_tool_definitions(self, tools: list[dict[str, Any]]) -> None:
        """Pin tool schemas as a system message. Replaces any existing tool-def pin."""
        if not tools:
            return
        content = "\n".join(f"Tool: {t.get('function', t).get('name', 'unknown')}" for t in tools)
        msg = {"role": "system", "content": f"[Available Tools]\n{content}", "_yarn_pin": "tools"}
        tokens = count_message_tokens(msg)

        for i, m in enumerate(self._pinned):
            if m.get("_yarn_pin") == "tools":
                old_tokens = count_message_tokens(m)
                self._pinned[i] = msg
                self._pinned_tokens += tokens - old_tokens
                return

        self._pinned.append(msg)
        self._pinned_tokens += tokens

    def set_memory_replay(self, summary: str) -> None:
        """Pin a memory-replay summary from the compressor."""
        msg = {"role": "system", "content": f"[Session Memory]\n{summary}", "_yarn_pin": "replay"}
        tokens = count_message_tokens(msg)

        for i, m in enumerate(self._pinned):
            if m.get("_yarn_pin") == "replay":
                old_tokens = count_message_tokens(m)
                self._pinned[i] = msg
                self._pinned_tokens += tokens - old_tokens
                return

        self._pinned.append(msg)
        self._pinned_tokens += tokens

    # --- Stable Zone ---

    def append_user(self, content: str, **metadata: Any) -> None:
        msg: dict[str, Any] = {"role": "user", "content": content}
        if metadata:
            msg["_meta"] = metadata
        tokens = count_message_tokens(msg)
        self._stable.append(msg)
        self._stable_tokens += tokens
        self._maybe_evict()

    def append_model(self, content: str, tool_calls: list[dict[str, Any]] | None = None) -> None:
        msg: dict[str, Any] = {"role": "assistant"}
        if content:
            msg["content"] = content
        if tool_calls:
            msg["tool_calls"] = tool_calls
        tokens = count_message_tokens(msg)
        self._stable.append(msg)
        self._stable_tokens += tokens
        self._maybe_evict()

    def append_tool_result(self, tool_call_id: str, name: str, content: str) -> None:
        wrapped = wrap_tool_result_content(name, content)
        msg = {"role": "tool", "tool_call_id": tool_call_id, "name": name, "content": wrapped}
        tokens = count_message_tokens(msg)
        self._stable.append(msg)
        self._stable_tokens += tokens
        self._maybe_evict()

    # --- Context Assembly ---

    def get_context(self, max_tokens: int | None = None) -> list[dict[str, Any]]:
        """Return the full context as a list of chat messages.

        The order is always: pinned -> stable (oldest first).
        Internal metadata keys (prefixed _) are stripped.
        """
        limit = max_tokens or self.max_tokens
        budget = limit - self._pinned_tokens
        if budget < 0:
            budget = 0

        messages: list[dict[str, Any]] = []
        for m in self._pinned:
            messages.append(_strip_internal(m))

        running = 0
        start_idx = 0
        if budget < self._stable_tokens:
            trimmed = 0
            for i, m in enumerate(self._stable):
                t = count_message_tokens(m)
                if self._stable_tokens - trimmed - t <= budget:
                    start_idx = i
                    break
                trimmed += t

        for m in self._stable[start_idx:]:
            messages.append(_strip_internal(m))
            running += count_message_tokens(m)
            if running > budget:
                break

        return messages

    @property
    def total_tokens(self) -> int:
        return self._pinned_tokens + self._stable_tokens

    @property
    def stable_turn_count(self) -> int:
        return len(self._stable)

    @property
    def utilization(self) -> float:
        if self.max_tokens == 0:
            return 0.0
        return self.total_tokens / self.max_tokens

    def get_evicted_turns(self) -> list[dict[str, Any]]:
        """Pop evicted turns for the compressor to summarize."""
        evicted = self._evicted_turns
        self._evicted_turns = []
        return evicted

    # --- Serialization ---

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_tokens": self.max_tokens,
            "pinned_budget": self.pinned_budget,
            "pinned": self._pinned,
            "stable": self._stable,
            "pinned_tokens": self._pinned_tokens,
            "stable_tokens": self._stable_tokens,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MemoryBuffer:
        buf = cls(
            max_tokens=data.get("max_tokens", 131072),
            pinned_budget=data.get("pinned_budget", 8192),
        )
        buf._pinned = data.get("pinned", [])
        buf._stable = data.get("stable", [])
        buf._pinned_tokens = data.get("pinned_tokens", 0)
        buf._stable_tokens = data.get("stable_tokens", 0)
        return buf

    # --- Internal ---

    def _maybe_evict(self) -> None:
        """Evict oldest stable messages when total exceeds max_tokens."""
        while self.total_tokens > self.max_tokens and self._stable:
            evicted = self._stable.pop(0)
            self._stable_tokens -= count_message_tokens(evicted)
            self._evicted_turns.append(evicted)
            self._last_eviction = time.time()


def _strip_internal(msg: dict[str, Any]) -> dict[str, Any]:
    """Remove internal metadata keys from a message before sending to model."""
    return {k: v for k, v in msg.items() if not k.startswith("_")}
