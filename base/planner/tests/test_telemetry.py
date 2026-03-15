"""Tests for the synesis_telemetry shared library.

Validates JSON log schema, context propagation, formatter behaviour,
span wrapper (no-op mode), and metrics re-exports.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from io import StringIO

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "images", "base-api", "synesis-telemetry"))

from synesis_telemetry import (
    configure_logging,
    set_node,
    set_request_context,
)
from synesis_telemetry.context import _node_name, _run_id, _user_id, get_context, set_service_name
from synesis_telemetry.formatter import SynesisJSONFormatter, SynesisTextFormatter
from synesis_telemetry.schema import LogEvent
from synesis_telemetry.spans import span

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _capture_json_log(
    logger_name: str = "synesis.test",
    event: str = "test_event",
    extras: dict | None = None,
    service: str = "test-svc",
) -> dict:
    """Set up a JSON handler on a fresh logger, emit one record, return parsed JSON."""
    buf = StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(SynesisJSONFormatter(service=service))

    lgr = logging.getLogger(logger_name)
    lgr.handlers = [handler]
    lgr.setLevel(logging.DEBUG)

    lgr.info(event, extra=extras or {})
    raw = buf.getvalue().strip()
    return json.loads(raw)


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


class TestLogEventSchema:
    """Ensure JSON output conforms to the canonical LogEvent shape."""

    REQUIRED_KEYS: frozenset[str] = frozenset({"ts", "level", "service", "logger", "event"})

    def test_required_fields_present(self):
        obj = _capture_json_log()
        assert set(obj.keys()) >= self.REQUIRED_KEYS

    def test_level_is_lowercase(self):
        obj = _capture_json_log()
        assert obj["level"] == "info"

    def test_ts_is_iso8601(self):
        from datetime import datetime

        obj = _capture_json_log()
        datetime.fromisoformat(obj["ts"])

    def test_extras_in_data_key(self):
        obj = _capture_json_log(extras={"latency_ms": 42, "count": 3})
        assert "data" in obj
        assert obj["data"]["latency_ms"] == 42
        assert obj["data"]["count"] == 3

    def test_no_data_key_when_no_extras(self):
        obj = _capture_json_log(extras={})
        assert "data" not in obj

    def test_event_is_string(self):
        obj = _capture_json_log(event="router_complete")
        assert obj["event"] == "router_complete"

    def test_service_name_injected(self):
        obj = _capture_json_log(service="synesis-planner")
        assert obj["service"] == "synesis-planner"


# ---------------------------------------------------------------------------
# Context propagation
# ---------------------------------------------------------------------------


class TestContextPropagation:
    """Verify run_id, user_id, node propagate into log JSON."""

    def setup_method(self):
        _run_id.set("")
        _user_id.set("")
        _node_name.set("")

    def test_run_id_in_log(self):
        set_request_context(run_id="abc-123")
        obj = _capture_json_log()
        assert obj["run_id"] == "abc-123"

    def test_user_id_in_log(self):
        set_request_context(user_id="user-42")
        obj = _capture_json_log()
        assert obj["user_id"] == "user-42"

    def test_node_in_log(self):
        set_node("router")
        obj = _capture_json_log()
        assert obj["node"] == "router"

    def test_context_not_present_when_empty(self):
        obj = _capture_json_log()
        assert "run_id" not in obj
        assert "user_id" not in obj
        assert "node" not in obj

    def test_get_context_returns_set_values(self):
        set_request_context(run_id="r1", user_id="u1")
        set_node("writer")
        set_service_name("svc")
        ctx = get_context()
        assert ctx == {"run_id": "r1", "user_id": "u1", "node": "writer", "service": "svc"}


# ---------------------------------------------------------------------------
# Text formatter
# ---------------------------------------------------------------------------


class TestTextFormatter:
    """SynesisTextFormatter produces human-readable dev output."""

    def setup_method(self):
        _run_id.set("")
        _user_id.set("")
        _node_name.set("")

    def test_basic_format(self):
        buf = StringIO()
        handler = logging.StreamHandler(buf)
        handler.setFormatter(SynesisTextFormatter())
        lgr = logging.getLogger("synesis.text_test")
        lgr.handlers = [handler]
        lgr.setLevel(logging.DEBUG)
        lgr.info("hello_world")
        line = buf.getvalue().strip()
        assert "synesis.text_test" in line
        assert "INFO" in line
        assert "hello_world" in line

    def test_run_id_truncated_in_text(self):
        set_request_context(run_id="abcdef123456789")
        buf = StringIO()
        handler = logging.StreamHandler(buf)
        handler.setFormatter(SynesisTextFormatter())
        lgr = logging.getLogger("synesis.text_test2")
        lgr.handlers = [handler]
        lgr.setLevel(logging.DEBUG)
        lgr.info("check_id")
        line = buf.getvalue().strip()
        assert "run_id=abcdef123456" in line


# ---------------------------------------------------------------------------
# Span wrapper (no-op mode)
# ---------------------------------------------------------------------------


class TestSpanNoOp:
    """With SYNESIS_OTEL_ENABLED=false (default), spans are no-ops."""

    def test_span_returns_noop(self):
        with span("test_span") as s:
            s.set_attribute("key", "value")
            s.add_event("something")
            s.record_exception(ValueError("test"))

    def test_span_propagates_exceptions(self):
        with pytest.raises(RuntimeError, match="boom"), span("fail_span"):
            raise RuntimeError("boom")


# ---------------------------------------------------------------------------
# configure_logging
# ---------------------------------------------------------------------------


class TestConfigureLogging:
    """Smoke-test the top-level configure_logging function."""

    def test_json_format(self):
        configure_logging(service="test-json", fmt="json")
        root = logging.getLogger()
        assert any(isinstance(h.formatter, SynesisJSONFormatter) for h in root.handlers)

    def test_text_format(self):
        configure_logging(service="test-text", fmt="text")
        root = logging.getLogger()
        assert any(isinstance(h.formatter, SynesisTextFormatter) for h in root.handlers)


# ---------------------------------------------------------------------------
# LogEvent dataclass
# ---------------------------------------------------------------------------


class TestLogEventDataclass:
    """LogEvent is a plain dataclass for documentation / validation."""

    def test_defaults(self):
        evt = LogEvent(
            ts="2026-03-11T00:00:00Z",
            level="info",
            service="test",
            logger="synesis.test",
            event="test_event",
        )
        assert evt.run_id == ""
        assert evt.data == {}

    def test_with_data(self):
        evt = LogEvent(
            ts="2026-03-11T00:00:00Z",
            level="warning",
            service="test",
            logger="synesis.test",
            event="something",
            run_id="r1",
            data={"key": "value"},
        )
        assert evt.run_id == "r1"
        assert evt.data["key"] == "value"


# ---------------------------------------------------------------------------
# Metrics re-exports
# ---------------------------------------------------------------------------


class TestMetricsReExport:
    """synesis_telemetry re-exports prometheus_client types."""

    def test_counter(self):
        from synesis_telemetry.metrics import Counter

        c = Counter("test_synesis_counter", "test", ["label"])
        c.labels(label="a").inc()

    def test_gauge(self):
        from synesis_telemetry.metrics import Gauge

        g = Gauge("test_synesis_gauge", "test")
        g.set(42)

    def test_generate_latest(self):
        from synesis_telemetry.metrics import generate_latest

        data = generate_latest()
        assert isinstance(data, bytes)
