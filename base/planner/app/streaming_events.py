"""Streaming support — Open WebUI status + Planner topic/plan + Executor debug bullets.

- StatusQueueCallback: Custom callback that emits status descriptions as nodes run.
- Planner: topic (reasoning) + plan steps yielded as 'status' for sidebar/header.
- Executor: tool-call/debug bullets via callback (sandbox, lint, etc.).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from langchain_core.callbacks import AsyncCallbackHandler

logger = logging.getLogger("synesis.streaming")

KNOWN_NODE_NAMES: frozenset[str] = frozenset(
    {
        "entry_classifier",
        "strategic_advisor",
        "supervisor",
        "planner",
        "context_curator",
        "worker",
        "patch_integrity_gate",
        "sandbox",
        "lsp_analyzer",
        "critic",
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
            self._put("Analyzing request…")
        elif "strategic_advisor" in n or "domain_aligner" in n:
            self._put("Detecting domain…")
        elif "planner" in n:
            self._put("Building execution plan…")
        elif "worker" in n:
            self._put("Generating code…")
        elif "critic" in n:
            self._put("Reviewing…")
        elif "sandbox" in n:
            self._put("Testing code…")
        elif "patch_integrity" in n or "gate" in n:
            self._put("Validating code…")
        elif "context_curator" in n:
            self._put("Gathering context…")
        elif "supervisor" in n:
            self._put("Planning…")
        elif "respond" in n:
            self._put("Finishing…")

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
