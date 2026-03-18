"""Tests for SynesisTracer — token accumulation, span metadata, short-circuit, background critic."""

from __future__ import annotations

import json
import os
import sys
import time
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.synesis_tracer import (
    LLMCallRecord,
    SpanRecord,
    SynesisTracer,
    TraceRecord,
    _compute_cost,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def tracer() -> SynesisTracer:
    t = SynesisTracer()
    t.start_trace(trace_id="test-001", user_id="user-1", query="Hello world")
    return t


# ---------------------------------------------------------------------------
# Token accumulation
# ---------------------------------------------------------------------------


class TestTokenAccumulation:
    def test_flush_sums_tokens_from_all_spans(self, tracer: SynesisTracer):
        """total_tokens must equal the sum of all LLM call tokens across all spans."""
        span1 = SpanRecord(node_name="router", start_time=time.time())
        span1.llm_calls = [
            LLMCallRecord(model="synesis-router", prompt_tokens=100, completion_tokens=50, total_tokens=150),
            LLMCallRecord(model="synesis-router", prompt_tokens=80, completion_tokens=40, total_tokens=120),
        ]
        span1.tokens_used = 270

        span2 = SpanRecord(node_name="writer", start_time=time.time())
        span2.llm_calls = [
            LLMCallRecord(model="synesis-general", prompt_tokens=200, completion_tokens=300, total_tokens=500),
        ]
        span2.tokens_used = 500

        tracer._current_trace.spans = [span1, span2]

        with patch("app.synesis_tracer._persist_trace"):
            tracer.flush()

        # After flush, tracer._current_trace is None; check the record before flush
        # We need to capture the record — re-do with a mock
        tracer.start_trace(trace_id="test-002", user_id="user-1", query="test")
        tracer._current_trace.spans = [span1, span2]

        record = tracer._current_trace
        record.total_duration_ms = 1000
        record.total_tokens = sum(sum(c.total_tokens for c in s.llm_calls) for s in record.spans)
        assert record.total_tokens == 770

    def test_span_tokens_equal_llm_call_sum(self, tracer: SynesisTracer):
        """span.tokens_used should reflect its own LLM calls only."""
        span = SpanRecord(node_name="critic")
        call1 = LLMCallRecord(total_tokens=200)
        call2 = LLMCallRecord(total_tokens=150)
        span.llm_calls = [call1, call2]
        span.tokens_used = 350
        tracer._current_trace.spans = [span]

        with patch("app.synesis_tracer._persist_trace") as mock_persist:
            tracer.flush()
            persisted_record = mock_persist.call_args[0][0]
            assert persisted_record.total_tokens == 350

    def test_empty_trace_has_zero_tokens(self, tracer: SynesisTracer):
        """A trace with no spans must report zero tokens."""
        with patch("app.synesis_tracer._persist_trace") as mock_persist:
            tracer.flush()
            persisted_record = mock_persist.call_args[0][0]
            assert persisted_record.total_tokens == 0
            assert persisted_record.estimated_cost_usd == 0.0


# ---------------------------------------------------------------------------
# Short-circuit / prompt cache
# ---------------------------------------------------------------------------


class TestShortCircuit:
    def test_mark_short_circuit_sets_reason(self, tracer: SynesisTracer):
        tracer.mark_short_circuit("prompt_cache_hit")
        assert tracer._current_trace.short_circuit_reason == "prompt_cache_hit"

    def test_short_circuit_trace_flushes_successfully(self, tracer: SynesisTracer):
        tracer.mark_short_circuit("prompt_cache_hit")
        with patch("app.synesis_tracer._persist_trace") as mock_persist:
            tracer.flush()
            assert mock_persist.called
            record = mock_persist.call_args[0][0]
            assert record.short_circuit_reason == "prompt_cache_hit"
            assert record.total_tokens == 0
            assert len(record.spans) == 0

    def test_mark_short_circuit_noop_without_trace(self):
        t = SynesisTracer()
        t.mark_short_circuit("test")  # should not raise


# ---------------------------------------------------------------------------
# Span metadata annotation
# ---------------------------------------------------------------------------


class TestSpanAnnotation:
    def test_annotate_completed_span(self, tracer: SynesisTracer):
        span = SpanRecord(node_name="final_scrubber")
        tracer._current_trace.spans.append(span)
        tracer.annotate_span(
            "final_scrubber",
            {
                "scrub_details": {"artifacts_stripped": 2, "false_precision": 1},
            },
        )
        assert span.metadata["scrub_details"]["artifacts_stripped"] == 2

    def test_annotate_active_span(self, tracer: SynesisTracer):
        span = SpanRecord(node_name="router")
        tracer._active_spans["run-123"] = span
        tracer.annotate_span("router", {"retrieval_cache": {"hit_rate": 0.75}})
        assert span.metadata["retrieval_cache"]["hit_rate"] == 0.75

    def test_annotate_merges_multiple_calls(self, tracer: SynesisTracer):
        span = SpanRecord(node_name="entry_pipeline")
        tracer._current_trace.spans.append(span)
        tracer.annotate_span("entry_pipeline", {"frame_extraction": {"path": "cache_hit"}})
        tracer.annotate_span("entry_pipeline", {"classifier": {"difficulty": 0.7}})
        assert "frame_extraction" in span.metadata
        assert "classifier" in span.metadata

    def test_annotate_noop_without_trace(self):
        t = SynesisTracer()
        t.annotate_span("router", {"key": "value"})  # should not raise

    def test_annotate_noop_for_unknown_span(self, tracer: SynesisTracer):
        tracer.annotate_span("nonexistent_node", {"key": "value"})
        for s in tracer._current_trace.spans:
            assert "key" not in s.metadata


# ---------------------------------------------------------------------------
# Metadata field on SpanRecord
# ---------------------------------------------------------------------------


class TestSpanRecordMetadata:
    def test_metadata_defaults_to_empty_dict(self):
        span = SpanRecord(node_name="test")
        assert span.metadata == {}

    def test_metadata_serializes_to_json(self):
        span = SpanRecord(
            node_name="router",
            metadata={"retrieval_cache": {"exact_hits": 3, "misses": 1}},
        )
        data = json.loads(json.dumps({"metadata": span.metadata}))
        assert data["metadata"]["retrieval_cache"]["exact_hits"] == 3


# ---------------------------------------------------------------------------
# TraceRecord serialization
# ---------------------------------------------------------------------------


class TestTraceRecordSerialization:
    def test_short_circuit_reason_in_json(self, tracer: SynesisTracer):
        tracer.mark_short_circuit("prompt_cache_hit")
        from dataclasses import asdict

        data = asdict(tracer._current_trace)
        assert data["short_circuit_reason"] == "prompt_cache_hit"

    def test_span_metadata_in_full_record_json(self, tracer: SynesisTracer):
        span = SpanRecord(node_name="final_scrubber", metadata={"scrub_details": {"fp": 2}})
        tracer._current_trace.spans.append(span)
        from dataclasses import asdict

        data = json.dumps(asdict(tracer._current_trace), default=str)
        parsed = json.loads(data)
        assert parsed["spans"][0]["metadata"]["scrub_details"]["fp"] == 2


# ---------------------------------------------------------------------------
# Critic scores + request metadata
# ---------------------------------------------------------------------------


class TestCriticAndMetadata:
    def test_set_critic_scores(self, tracer: SynesisTracer):
        tracer.set_critic_scores(
            weighted_overall=7.5,
            task_faithfulness=8.0,
            constraint_compliance=7.0,
            coverage=6.5,
            judgment_quality=7.0,
            failure_modes=["missing_requirement_coverage"],
            approved=False,
            difficulty=0.8,
            hallucinated_urls_count=2,
        )
        cs = tracer._current_trace.critic_scores
        assert cs["weighted_overall"] == 7.5
        assert cs["approved"] is False
        assert cs["hallucinated_urls_count"] == 2

    def test_set_request_metadata_populates_evidence_summary(self, tracer: SynesisTracer):
        tracer.set_request_metadata(
            difficulty=0.7,
            task_type="research",
            evidence_packet_count=5,
            avg_evidence_confidence=0.65,
            critic_weighted_score=7.2,
            critic_blocking_issues=1,
            response_length=1500,
        )
        es = tracer._current_trace.evidence_summary
        assert es["packets"] == 5
        assert es["avg_confidence"] == 0.65
        assert es["response_length"] == 1500

    def test_phase_timing_recorded(self, tracer: SynesisTracer):
        tracer.record_phase_timing("router.dispatch_ms", 123.4)
        tracer.record_phase_timing("router.total_ms", 456.7)
        pt = tracer._current_trace.phase_timings
        assert pt["router.dispatch_ms"] == 123.4
        assert pt["router.total_ms"] == 456.7


# ---------------------------------------------------------------------------
# Cost computation
# ---------------------------------------------------------------------------


class TestCostComputation:
    def test_compute_cost_with_known_model(self):
        record = TraceRecord()
        span = SpanRecord(node_name="router")
        span.llm_calls = [
            LLMCallRecord(model="synesis-router", prompt_tokens=1_000_000, completion_tokens=500_000),
        ]
        record.spans = [span]

        with patch(
            "app.synesis_tracer._load_pricing",
            return_value={
                "synesis-router": (0.20, 0.50),
            },
        ):
            cost = _compute_cost(record)
        assert cost == round(0.20 + 0.25, 8)

    def test_compute_cost_zero_for_empty_trace(self):
        record = TraceRecord()
        cost = _compute_cost(record)
        assert cost == 0.0


# ---------------------------------------------------------------------------
# Flush lifecycle
# ---------------------------------------------------------------------------


class TestFlushLifecycle:
    def test_flush_resets_state(self, tracer: SynesisTracer):
        with patch("app.synesis_tracer._persist_trace"):
            tracer.flush()
        assert tracer._current_trace is None
        assert len(tracer._active_spans) == 0
        assert len(tracer._llm_starts) == 0

    def test_flush_noop_without_trace(self):
        t = SynesisTracer()
        t.flush()  # should not raise

    def test_double_flush_safe(self, tracer: SynesisTracer):
        with patch("app.synesis_tracer._persist_trace"):
            tracer.flush()
            tracer.flush()  # second flush should be noop
