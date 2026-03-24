"""Unit tests for the escalation module."""

from __future__ import annotations

from app.escalation.detector import (
    check_all,
    check_context_pressure,
    check_tool_loop_count,
    check_tool_result,
)
from app.memory.buffer import MemoryBuffer
from app.tools.orchestrator import ToolResult


class TestEscalationDetector:
    def test_tool_result_escalation(self):
        result = ToolResult("tc_1", "synesis_escalate", "ok", escalate=True, escalate_query="help")
        sig = check_tool_result(result)
        assert sig.should_escalate is True
        assert "help" in sig.query

    def test_tool_result_no_escalation(self):
        result = ToolResult("tc_1", "regular_tool", "data")
        sig = check_tool_result(result)
        assert sig.should_escalate is False

    def test_context_pressure_below_threshold(self):
        buf = MemoryBuffer(max_tokens=10000)
        buf.set_system_prompt("Short prompt")
        sig = check_context_pressure(buf)
        assert sig.should_escalate is False

    def test_context_pressure_above_threshold(self):
        buf = MemoryBuffer(max_tokens=30)
        buf.set_system_prompt("The quick brown fox " * 50)
        assert buf.utilization >= 0.9
        sig = check_context_pressure(buf)
        assert sig.should_escalate is True

    def test_tool_loop_within_limit(self):
        sig = check_tool_loop_count(5)
        assert sig.should_escalate is False

    def test_tool_loop_exceeds_limit(self):
        sig = check_tool_loop_count(100)
        assert sig.should_escalate is True

    def test_check_all_no_escalation(self):
        buf = MemoryBuffer(max_tokens=100000)
        buf.set_system_prompt("sys")
        sig = check_all(buf, tool_loop_count=0)
        assert sig.should_escalate is False

    def test_check_all_tool_escalation(self):
        buf = MemoryBuffer(max_tokens=100000)
        buf.set_system_prompt("sys")
        result = ToolResult("tc_1", "esc", "ok", escalate=True, escalate_query="q")
        sig = check_all(buf, tool_loop_count=0, last_tool_result=result)
        assert sig.should_escalate is True
