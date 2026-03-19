"""Unit tests for the Yarn memory buffer."""

from __future__ import annotations

import pytest

from app.memory.buffer import MemoryBuffer, count_tokens, count_message_tokens
from app.memory.delta_stitcher import estimate_cache_hit_tokens, stitch_delta
from app.memory.prefix_optimizer import validate_prefix_order, compute_prefix_stability
from app.memory.compressor import build_summarize_messages, merge_replay


class TestMemoryBuffer:
    def test_empty_buffer(self):
        buf = MemoryBuffer(max_tokens=10000)
        assert buf.total_tokens == 0
        assert buf.stable_turn_count == 0
        assert buf.get_context() == []

    def test_system_prompt_pinning(self, memory_buffer: MemoryBuffer):
        ctx = memory_buffer.get_context()
        assert len(ctx) == 1
        assert ctx[0]["role"] == "system"
        assert "helpful assistant" in ctx[0]["content"]

    def test_append_user_and_model(self, memory_buffer: MemoryBuffer):
        memory_buffer.append_user("Hello")
        memory_buffer.append_model("Hi there!")
        ctx = memory_buffer.get_context()
        assert len(ctx) == 3  # system + user + assistant
        assert ctx[1]["role"] == "user"
        assert ctx[2]["role"] == "assistant"

    def test_tool_result_appended(self, memory_buffer: MemoryBuffer):
        memory_buffer.append_user("Run a tool")
        memory_buffer.append_model("", tool_calls=[{
            "id": "tc_1",
            "type": "function",
            "function": {"name": "test_tool", "arguments": "{}"},
        }])
        memory_buffer.append_tool_result("tc_1", "test_tool", "result data")
        ctx = memory_buffer.get_context()
        assert any(m["role"] == "tool" for m in ctx)

    def test_eviction_on_overflow(self):
        buf = MemoryBuffer(max_tokens=100, pinned_budget=50)
        buf.set_system_prompt("Short sys prompt")
        for i in range(50):
            buf.append_user(f"Message number {i} with some padding text")

        assert buf.total_tokens <= buf.max_tokens + 50
        evicted = buf.get_evicted_turns()
        assert len(evicted) > 0

    def test_three_zone_layout(self, memory_buffer: MemoryBuffer):
        memory_buffer.set_tool_definitions([
            {"function": {"name": "tool_a"}},
            {"function": {"name": "tool_b"}},
        ])
        memory_buffer.set_memory_replay("Previous session summary")
        memory_buffer.append_user("Hello")
        memory_buffer.append_model("Hi!")

        ctx = memory_buffer.get_context()
        # All system messages should come first
        system_seen = True
        for msg in ctx:
            if msg["role"] == "system":
                assert system_seen, "System message after non-system"
            else:
                system_seen = False

    def test_serialization_roundtrip(self, memory_buffer: MemoryBuffer):
        memory_buffer.append_user("Hello")
        memory_buffer.append_model("World")

        data = memory_buffer.to_dict()
        restored = MemoryBuffer.from_dict(data)

        assert restored.total_tokens == memory_buffer.total_tokens
        assert restored.get_context() == memory_buffer.get_context()

    def test_utilization(self, memory_buffer: MemoryBuffer):
        assert 0.0 < memory_buffer.utilization < 1.0
        memory_buffer.append_user("x " * 200)
        assert memory_buffer.utilization > 0.0

    def test_internal_keys_stripped(self, memory_buffer: MemoryBuffer):
        memory_buffer.set_tool_definitions([{"function": {"name": "t"}}])
        ctx = memory_buffer.get_context()
        for msg in ctx:
            for key in msg:
                assert not key.startswith("_"), f"Internal key {key} leaked"


class TestDeltaStitcher:
    def test_stitch_appends_user(self, memory_buffer: MemoryBuffer):
        initial_count = memory_buffer.stable_turn_count
        stitch_delta(memory_buffer, "New message")
        assert memory_buffer.stable_turn_count == initial_count + 1

    def test_cache_hit_estimate(self, memory_buffer: MemoryBuffer):
        memory_buffer.append_user("First turn")
        memory_buffer.append_model("Response 1")
        memory_buffer.append_user("Second turn")

        est = estimate_cache_hit_tokens(memory_buffer)
        assert est > memory_buffer._pinned_tokens


class TestPrefixOptimizer:
    def test_valid_order(self):
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ]
        warnings = validate_prefix_order(msgs)
        assert len(warnings) == 0

    def test_system_after_user_warns(self):
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hi"},
            {"role": "system", "content": "oops"},
        ]
        warnings = validate_prefix_order(msgs)
        assert len(warnings) > 0

    def test_prefix_stability(self):
        prev = [{"role": "system", "content": "a"}, {"role": "user", "content": "b"}]
        curr = [{"role": "system", "content": "a"}, {"role": "user", "content": "b"}, {"role": "user", "content": "c"}]
        result = compute_prefix_stability(prev, curr)
        assert result["shared_messages"] == 2
        assert result["divergence_index"] == 2


class TestCompressor:
    def test_build_summarize_messages(self):
        evicted = [
            {"role": "user", "content": "old question"},
            {"role": "assistant", "content": "old answer"},
        ]
        messages = build_summarize_messages(evicted)
        assert len(messages) == 2
        assert messages[0]["role"] == "system"
        assert "summarizer" in messages[0]["content"].lower()

    def test_merge_replay(self):
        merged = merge_replay("", "New summary")
        assert merged == "New summary"

        merged = merge_replay("Old context", "New stuff")
        assert "Old context" in merged
        assert "New stuff" in merged


class TestTokenCounting:
    def test_count_tokens(self):
        assert count_tokens("hello world") > 0

    def test_count_message_tokens(self):
        msg = {"role": "user", "content": "hello world"}
        tokens = count_message_tokens(msg)
        assert tokens > 0
