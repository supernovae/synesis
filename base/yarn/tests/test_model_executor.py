"""Unit tests for the model execution layer."""

from __future__ import annotations

import pytest

from app.model.circuit_breaker import CLOSED, HALF_OPEN, OPEN, CircuitBreaker
from app.model.stream_handler import (
    StreamChunk,
    ToolCallAccumulator,
    extract_chunk,
    parse_sse_line,
)
from app.model.usage_tracker import UsageAggregator, UsageRecord


class TestCircuitBreaker:
    def test_initial_state(self):
        cb = CircuitBreaker("test")
        assert cb.state == CLOSED
        assert cb.allow_request() is True

    def test_opens_after_threshold(self):
        cb = CircuitBreaker("test", failure_threshold=3)
        for _ in range(3):
            cb.record_failure()
        assert cb.state == OPEN
        assert cb.allow_request() is False

    def test_success_resets(self):
        cb = CircuitBreaker("test", failure_threshold=3)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        assert cb.state == CLOSED
        assert cb.allow_request() is True

    def test_half_open_transition(self):
        cb = CircuitBreaker("test", failure_threshold=1, recovery_timeout=0.0)
        cb.record_failure()
        assert cb.state == HALF_OPEN  # immediate because timeout=0
        assert cb.allow_request() is True

    def test_half_open_failure_reopens(self):
        cb = CircuitBreaker("test", failure_threshold=1, recovery_timeout=0.0)
        cb.record_failure()
        _ = cb.state  # trigger transition to HALF_OPEN
        cb.record_failure()
        assert cb._state == OPEN


class TestStreamHandler:
    def test_parse_sse_done(self):
        assert parse_sse_line("data: [DONE]") == {"_done": True}

    def test_parse_sse_data(self):
        data = parse_sse_line('data: {"choices":[{"delta":{"content":"hi"}}]}')
        assert data is not None
        assert "choices" in data

    def test_parse_sse_empty(self):
        assert parse_sse_line("") is None
        assert parse_sse_line(": comment") is None

    def test_extract_chunk_content(self):
        data = {"choices": [{"delta": {"content": "hello"}, "finish_reason": None}]}
        chunk = extract_chunk(data)
        assert chunk.content == "hello"
        assert chunk.finish_reason is None

    def test_extract_chunk_tool_calls(self):
        data = {
            "choices": [{
                "delta": {
                    "tool_calls": [{"index": 0, "id": "tc_1", "function": {"name": "test", "arguments": '{"a":'}}]
                },
                "finish_reason": None,
            }]
        }
        chunk = extract_chunk(data)
        assert len(chunk.tool_calls) == 1


class TestToolCallAccumulator:
    def test_accumulate_and_flush(self):
        acc = ToolCallAccumulator()
        acc.feed([{"index": 0, "id": "tc_1", "function": {"name": "test", "arguments": '{"q":'}}])
        acc.feed([{"index": 0, "function": {"arguments": '"hello"}'}}])
        assert acc.has_pending
        calls = acc.flush()
        assert len(calls) == 1
        assert calls[0]["function"]["name"] == "test"
        assert calls[0]["function"]["arguments"] == '{"q":"hello"}'

    def test_multiple_tool_calls(self):
        acc = ToolCallAccumulator()
        acc.feed([{"index": 0, "id": "tc_1", "function": {"name": "a", "arguments": "{}"}}])
        acc.feed([{"index": 1, "id": "tc_2", "function": {"name": "b", "arguments": "{}"}}])
        calls = acc.flush()
        assert len(calls) == 2


class TestUsageTracker:
    def test_cost_computation_deepinfra(self):
        record = UsageRecord(
            provider="deepinfra",
            tokens_in=100_000,
            tokens_out=1_000,
            tokens_cached=80_000,
        )
        cost = record.compute_cost()
        assert cost > 0
        assert record.tokens_uncached == 20_000
        # cached: 80K * $0.022/M = $0.00176
        # uncached: 20K * $0.22/M = $0.0044
        # output: 1K * $1.00/M = $0.001
        expected = 0.00176 + 0.0044 + 0.001
        assert abs(cost - expected) < 0.001

    def test_local_provider_free(self):
        record = UsageRecord(provider="local", tokens_in=100_000, tokens_out=1000)
        assert record.compute_cost() == 0.0

    def test_aggregator(self):
        agg = UsageAggregator()
        agg.add(UsageRecord(provider="deepinfra", tokens_in=100, tokens_out=10, tokens_cached=80))
        agg.add(UsageRecord(provider="deepinfra", tokens_in=200, tokens_out=20, tokens_cached=160))
        assert agg.total_tokens_in == 300
        assert agg.total_tokens_out == 30
        assert agg.total_tokens_cached == 240
        assert agg.cache_hit_rate == 240 / 300
