"""Streaming support — Open WebUI status + Planner topic/plan + Executor debug bullets.

- StatusQueueCallback: Custom callback that emits status descriptions as nodes run.
- Planner: topic (reasoning) + plan steps yielded as 'status' for sidebar/header.
- Executor: tool-call/debug bullets via callback (lint, etc.).
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

    def __init__(self, queue: asyncio.Queue[str | None], enhanced_progress: bool = False) -> None:
        super().__init__()
        self._queue = queue
        self._enhanced_progress = enhanced_progress

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
        if not self._enhanced_progress or not isinstance(outputs, dict):
            return

        packets = outputs.get("evidence_packets")
        if isinstance(packets, list) and packets:
            total_sources = 0
            total_web = 0
            for p in packets:
                if not isinstance(p, dict):
                    continue
                sources = p.get("sources") or []
                total_sources += len(sources)
                total_web += sum(1 for s in sources if isinstance(s, dict) and s.get("type") == "web")
            total_docs = max(total_sources - total_web, 0)
            parts: list[str] = []
            if total_web:
                parts.append(f"{total_web} web")
            if total_docs:
                parts.append(f"{total_docs} docs")
            detail = f" ({' + '.join(parts)})" if parts else ""
            if total_sources:
                self._put(f"Evidence gathered: {total_sources} sources{detail}")

        plan = outputs.get("execution_plan")
        if isinstance(plan, dict):
            steps = plan.get("steps")
            if isinstance(steps, list) and steps:
                self._put(f"Plan ready: {len(steps)} sections prepared")
