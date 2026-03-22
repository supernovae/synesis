"""Escalation trigger logic — decides when the fast loop should hand off to the planner."""

from __future__ import annotations

import logging

from ..config import settings
from ..memory.buffer import MemoryBuffer
from ..tools.orchestrator import ToolResult

logger = logging.getLogger("yarn.escalation.detector")


class EscalationSignal:
    __slots__ = ("query", "reason", "should_escalate")

    def __init__(self, should_escalate: bool = False, reason: str = "", query: str = ""):
        self.should_escalate = should_escalate
        self.reason = reason
        self.query = query


def check_tool_result(result: ToolResult) -> EscalationSignal:
    """Check if a tool result signals escalation."""
    if result.escalate:
        return EscalationSignal(
            should_escalate=True,
            reason=f"Tool {result.name} requested escalation",
            query=result.escalate_query,
        )
    return EscalationSignal()


def check_context_pressure(buf: MemoryBuffer) -> EscalationSignal:
    """Escalate when the memory buffer is nearly full."""
    if buf.utilization >= settings.escalation_context_threshold:
        return EscalationSignal(
            should_escalate=True,
            reason=f"Context utilization at {buf.utilization:.0%}, exceeds threshold",
            query="Context window pressure — escalating for RAG-backed response",
        )
    return EscalationSignal()


def check_tool_loop_count(loop_count: int) -> EscalationSignal:
    """Escalate when too many consecutive tool calls suggest the model is stuck."""
    if loop_count >= settings.escalation_max_tool_loops:
        return EscalationSignal(
            should_escalate=True,
            reason=f"Tool loop count {loop_count} exceeds max {settings.escalation_max_tool_loops}",
            query="Too many tool calls — escalating for planner decomposition",
        )
    return EscalationSignal()


def check_all(
    buf: MemoryBuffer,
    tool_loop_count: int,
    last_tool_result: ToolResult | None = None,
) -> EscalationSignal:
    """Run all escalation checks. Returns the first triggered signal, or none."""
    if last_tool_result:
        sig = check_tool_result(last_tool_result)
        if sig.should_escalate:
            return sig

    sig = check_context_pressure(buf)
    if sig.should_escalate:
        return sig

    sig = check_tool_loop_count(tool_loop_count)
    if sig.should_escalate:
        return sig

    return EscalationSignal()
