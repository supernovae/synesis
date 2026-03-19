"""SSE stream parsing and tool-call detection.

Parses the OpenAI streaming format and accumulates tool calls that may
arrive across multiple chunks.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("yarn.model.stream")


@dataclass
class StreamChunk:
    """A parsed chunk from the model stream."""

    content: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    finish_reason: str | None = None
    usage: dict[str, int] | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolCallAccumulator:
    """Accumulates partial tool calls from streaming chunks."""

    _pending: dict[int, dict[str, Any]] = field(default_factory=dict)

    def feed(self, delta_tool_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Feed delta tool_calls from a streaming chunk.

        Returns completed tool calls (when a new index appears after a previous
        one was building, or on stream end).
        """
        for tc in delta_tool_calls:
            idx = tc.get("index", 0)
            if idx not in self._pending:
                self._pending[idx] = {
                    "id": tc.get("id", ""),
                    "type": "function",
                    "function": {"name": "", "arguments": ""},
                }

            entry = self._pending[idx]
            if tc.get("id"):
                entry["id"] = tc["id"]
            fn = tc.get("function", {})
            if fn.get("name"):
                entry["function"]["name"] = fn["name"]
            if fn.get("arguments"):
                entry["function"]["arguments"] += fn["arguments"]

        return []

    def flush(self) -> list[dict[str, Any]]:
        """Return all accumulated tool calls and reset."""
        result = [self._pending[i] for i in sorted(self._pending)]
        self._pending.clear()
        return result

    @property
    def has_pending(self) -> bool:
        return bool(self._pending)


def parse_sse_line(line: str) -> dict[str, Any] | None:
    """Parse a single SSE data line into a dict."""
    line = line.strip()
    if not line or line.startswith(":"):
        return None
    if line == "data: [DONE]":
        return {"_done": True}
    if line.startswith("data: "):
        try:
            return json.loads(line[6:])
        except json.JSONDecodeError:
            logger.warning("Failed to parse SSE line: %s", line[:100])
            return None
    return None


def extract_chunk(data: dict[str, Any]) -> StreamChunk:
    """Extract a StreamChunk from a parsed SSE data object."""
    chunk = StreamChunk(raw=data)

    choices = data.get("choices", [])
    if choices:
        choice = choices[0]
        delta = choice.get("delta", {})
        chunk.content = delta.get("content", "") or ""
        if delta.get("tool_calls"):
            chunk.tool_calls = delta["tool_calls"]
        chunk.finish_reason = choice.get("finish_reason")

    if data.get("usage"):
        chunk.usage = data["usage"]

    return chunk
