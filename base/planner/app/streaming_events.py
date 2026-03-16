"""Streaming support — Open WebUI status + Planner topic/plan + Executor debug bullets.

- StatusQueueCallback: Custom callback that emits status descriptions as nodes run.
- emit_sub_phase(): ContextVar-based mechanism for graph nodes to push sub-phase
  status updates that the SSE generator drains alongside heartbeats.
- Planner: topic (reasoning) + plan steps yielded as 'status' for sidebar/header.
- Executor: tool-call/debug bullets via callback (lint, etc.).
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import logging
from typing import Any

from langchain_core.callbacks import AsyncCallbackHandler

logger = logging.getLogger("synesis.streaming")

# ---------------------------------------------------------------------------
# Sub-phase status: allows graph nodes (e.g. entry_pipeline) to push
# fine-grained status updates that the SSE generator drains each poll cycle.
# ---------------------------------------------------------------------------

_sub_phase_queue: contextvars.ContextVar[asyncio.Queue[str] | None] = contextvars.ContextVar(
    "_sub_phase_queue", default=None
)


def set_sub_phase_queue(q: asyncio.Queue[str] | None) -> contextvars.Token[asyncio.Queue[str] | None]:
    """Set the sub-phase queue for the current async context (called by SSE generator)."""
    return _sub_phase_queue.set(q)


def emit_sub_phase(description: str) -> None:
    """Push a sub-phase status from within a graph node (non-blocking, fire-and-forget)."""
    q = _sub_phase_queue.get(None)
    if q is not None and description:
        with contextlib.suppress(asyncio.QueueFull):
            q.put_nowait(description)

KNOWN_NODE_NAMES: frozenset[str] = frozenset(
    {
        "entry_classifier",
        "strategic_advisor",
        "frame_extractor",
        "router",
        "planner",
        "executor",
        "writer",
        "patch_integrity_gate",
        "critic",
        "final_scrubber",
        "respond",
    }
)


class StatusQueueCallback(AsyncCallbackHandler):
    """Emits status descriptions to an async queue for Open WebUI.

    Used as CallbackHandler passed via config; runs as Planner/Worker/Sandbox execute.
    """

    def __init__(self, queue: asyncio.Queue[str | None]) -> None:
        super().__init__()
        self._queue = queue

    def _put(self, desc: str) -> None:
        with contextlib.suppress(asyncio.QueueFull):
            self._queue.put_nowait(desc)

    def on_chain_start(
        self,
        serialized: dict[str, Any],
        inputs: dict[str, Any],
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        if not serialized:
            return
        name = ""
        if "id" in serialized:
            rid = serialized["id"]
            if isinstance(rid, list):
                name = str(rid[-1]) if rid else ""
            else:
                name = str(rid)
        name = name or serialized.get("name", "")
        n = str(name).lower()
        if "entry_classifier" in n:
            self._put("Classifying request\u2026")
        elif "strategic_advisor" in n or "domain_aligner" in n:
            self._put("Assessing strategy\u2026")
        elif "frame_extractor" in n:
            self._put("Extracting intent\u2026")
        elif "planner" in n:
            self._put("Building plan\u2026")
        elif "router" in n:
            self._put("Gathering evidence\u2026")
        elif "executor" in n:
            self._put("Generating code\u2026")
        elif "writer" in n and "scrubber" not in n:
            self._put("Composing response\u2026")
        elif "critic" in n:
            self._put("Evaluating quality\u2026")
        elif "patch_integrity" in n or "gate" in n:
            self._put("Validating code\u2026")
        elif "respond" in n:
            self._put("Finalizing\u2026")

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        name = serialized.get("name", "")
        if name:
            self._put(f"Running: {name}")

    def on_chain_end(
        self,
        outputs: dict[str, Any],
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        # Standard status is emitted by on_chain_start only; no post-node summaries here.
        pass
