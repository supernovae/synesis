"""Tests for observability wiring: error recording, cache counters, dashboard parallel."""

from __future__ import annotations

import asyncio
import os
import sys
import time
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ---------------------------------------------------------------------------
# record_error — Postgres-only error persistence
# ---------------------------------------------------------------------------


class TestRecordError:
    """Verify record_error fires a daemon thread that writes to Postgres."""

    def test_record_error_spawns_thread(self):
        """record_error should spawn a daemon thread without blocking."""
        from app.failure_store import record_error

        with patch("app.failure_store._persist_error") as mock_persist:
            record_error(
                error_type="graph_error",
                error_output="node=router: TimeoutError",
                task_description="test task",
                trace_id="trace-123",
            )
            time.sleep(0.15)
            mock_persist.assert_called_once_with(
                "graph_error",
                "node=router: TimeoutError",
                "test task",
                "",
                "",
                1,
                "trace-123",
            )

    def test_persist_error_builds_failure_id(self):
        """_persist_error should compute a deterministic failure_id."""
        from contextlib import contextmanager

        from app.failure_store import _persist_error

        mock_cursor = MagicMock()
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__ = lambda s: mock_cursor
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)

        @contextmanager
        def _fake_pool(*, autocommit=True):
            mock_conn.autocommit = autocommit
            yield mock_conn

        with patch("app.pg_pool.pg_connection", _fake_pool):
            _persist_error(
                error_type="retrieval_timeout",
                error_output="Retrieval timed out after 30s",
                task_description="how to deploy kubernetes",
                trace_id="abc123",
            )

        mock_cursor.execute.assert_called_once()
        call_args = mock_cursor.execute.call_args
        sql = call_args[0][0]
        assert "INSERT INTO failures" in sql
        params = call_args[0][1]
        assert params[3] == 1  # exit_code
        assert params[4] == "retrieval_timeout"  # error_type

    def test_persist_error_no_db_url(self):
        """_persist_error should silently no-op when pool yields None."""
        from contextlib import contextmanager

        from app.failure_store import _persist_error

        @contextmanager
        def _no_pool(*, autocommit=True):
            yield None

        with patch("app.pg_pool.pg_connection", _no_pool):
            _persist_error(
                error_type="graph_error",
                error_output="some error",
            )

    def test_record_error_different_error_types(self):
        """All supported error types should be accepted."""
        from app.failure_store import record_error

        for etype in (
            "graph_error",
            "timeout",
            "retrieval_timeout",
            "retrieval_error",
            "model_timeout",
            "critic_error",
        ):
            with patch("app.failure_store._persist_error"):
                record_error(error_type=etype, error_output="test")

    def test_persist_error_trace_id_appended(self):
        """When trace_id is provided, it should be appended to the failure_id."""
        from contextlib import contextmanager

        from app.failure_store import _persist_error

        mock_cursor = MagicMock()
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__ = lambda s: mock_cursor
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)

        @contextmanager
        def _fake_pool(*, autocommit=True):
            mock_conn.autocommit = autocommit
            yield mock_conn

        with patch("app.pg_pool.pg_connection", _fake_pool):
            _persist_error(
                error_type="graph_error",
                error_output="boom",
                trace_id="run-abc-def",
            )

        params = mock_cursor.execute.call_args[0][1]
        fid = params[0]
        assert "_run-abc-def" in fid


# ---------------------------------------------------------------------------
# Cache Prometheus counters
# ---------------------------------------------------------------------------


class TestCacheCounters:
    """Verify Prometheus counters are incremented on cache hits/misses."""

    def test_prompt_cache_counters_no_error(self):
        from app.api_metrics import (
            _ensure_metrics,
            record_prompt_cache_hit,
            record_prompt_cache_miss,
            record_prompt_cache_size,
        )

        _ensure_metrics()
        record_prompt_cache_hit()
        record_prompt_cache_miss()
        record_prompt_cache_size(5)

    def test_frame_cache_counters_no_error(self):
        from app.api_metrics import (
            _ensure_metrics,
            record_frame_cache_hit,
            record_frame_cache_miss,
            record_frame_cache_size,
        )

        _ensure_metrics()
        record_frame_cache_hit()
        record_frame_cache_miss()
        record_frame_cache_size(10)

    def test_counter_values_increment(self):
        """Prometheus counters should actually increment."""
        from app.api_metrics import _ensure_metrics

        _ensure_metrics()
        from app.api_metrics import _prompt_cache_hits, _prompt_cache_misses

        if _prompt_cache_hits is None:
            pytest.skip("prometheus_client not available")

        before_hits = _prompt_cache_hits._value.get()
        from app.api_metrics import record_prompt_cache_hit

        record_prompt_cache_hit()
        after_hits = _prompt_cache_hits._value.get()
        assert after_hits == before_hits + 1

        before_misses = _prompt_cache_misses._value.get()
        from app.api_metrics import record_prompt_cache_miss

        record_prompt_cache_miss()
        after_misses = _prompt_cache_misses._value.get()
        assert after_misses == before_misses + 1


# ---------------------------------------------------------------------------
# Dashboard parallel response — _safe helper pattern
# ---------------------------------------------------------------------------


async def _safe(coro, label: str, default=None):
    """Mirrors the _safe helper from admin dashboard.py for isolated testing."""
    try:
        return await coro
    except Exception:
        return default


class TestDashboardSafeHelper:
    """Verify the _safe async wrapper pattern used by the dashboard."""

    def test_safe_returns_default_on_error(self):
        async def _fail():
            raise RuntimeError("boom")

        result = asyncio.run(_safe(_fail(), "test", {"fallback": True}))
        assert result == {"fallback": True}

    def test_safe_returns_value_on_success(self):
        async def _ok():
            return {"data": 1}

        result = asyncio.run(_safe(_ok(), "test", None))
        assert result == {"data": 1}

    def test_safe_returns_none_default(self):
        async def _fail():
            raise ValueError("nope")

        result = asyncio.run(_safe(_fail(), "test", None))
        assert result is None

    def test_gather_partial_failures(self):
        """Verify asyncio.gather with _safe tolerates mixed success/failure."""

        async def _run():
            async def _ok1():
                return "a"

            async def _fail():
                raise RuntimeError("down")

            async def _ok2():
                return "b"

            return await asyncio.gather(
                _safe(_ok1(), "ok1", None),
                _safe(_fail(), "fail", "default"),
                _safe(_ok2(), "ok2", None),
            )

        results = asyncio.run(_run())
        assert results == ["a", "default", "b"]


# ---------------------------------------------------------------------------
# Prometheus client service — cache metrics parsing
# ---------------------------------------------------------------------------


class TestPromClientCacheMetrics:
    """Verify admin prometheus_client_svc parses new cache counters."""

    def test_build_retrieval_cache(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "admin"))
        try:
            from app.services.prometheus_client_svc import _build_retrieval_cache
        except ImportError:
            pytest.skip("admin app not importable from planner test env")

        raw = {
            "synesis_cache_exact_hits_total": 10.0,
            "synesis_cache_semantic_hits_total": 5.0,
            "synesis_cache_misses_total": 15.0,
            "synesis_cache_evictions_total": 2.0,
            "synesis_cache_entries": 8.0,
        }
        result = _build_retrieval_cache(raw)
        assert result["exact_hits"] == 10.0
        assert result["semantic_hits"] == 5.0
        assert result["misses"] == 15.0
        assert abs(result["hit_rate"] - 0.5) < 0.01

    def test_remediation_hints(self):
        try:
            from app.services.prometheus_client_svc import _remediation
        except ImportError:
            pytest.skip("admin app not importable from planner test env")

        assert _remediation("llm", "open") is not None
        assert _remediation("llm", "closed") is None
        assert _remediation("web_search", "open") is not None
        assert _remediation("infrastructure", "closed") is None
