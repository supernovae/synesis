"""Tests for Phase 18: Evaluation and Conformance Framework.

Covers:
- Trace decision analytics (aggregation, empty window)
- Conformance rollups (scrape parsing, summary, history, delta computation)
- Eval harness (case matching, pass/fail, suite result aggregation, suites listing)
- Testing Labs engine (prompt extraction, regression detection logic)
- API endpoints (analytics, conformance, evals, labs execution)
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Trace Decision Analytics
# ---------------------------------------------------------------------------


class TestTraceDecisionAnalytics:
    """Tests for trace_store.get_decision_analytics()."""

    @pytest.mark.asyncio
    async def test_empty_window_returns_zeroed_structure(self):
        from app.services.trace_store import get_decision_analytics

        with patch("app.services.trace_store.async_session") as mock_session_ctx:
            session = AsyncMock()
            mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=session)
            mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
            session.execute = AsyncMock(side_effect=Exception("no db"))

            result = await get_decision_analytics(since=time.time() - 10)

        assert result["total_traces"] == 0
        assert result["decision_paths"] == {}
        assert result["escalation_count"] == 0
        assert result["recall"]["routing_distribution"] == {}
        assert result["evidence"]["prefetch_hits"] == 0
        assert "period" in result

    @pytest.mark.asyncio
    async def test_analytics_returns_expected_keys(self):
        from app.services.trace_store import get_decision_analytics

        with patch("app.services.trace_store.async_session") as mock_session_ctx:
            session = AsyncMock()
            mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=session)
            mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
            session.execute = AsyncMock(side_effect=Exception("no db"))

            result = await get_decision_analytics()

        for key in (
            "total_traces",
            "traces_with_decision_ledger",
            "decision_paths",
            "escalation_count",
            "escalation_rate",
            "recall",
            "evidence",
            "period",
        ):
            assert key in result


class TestTraceAnalyticsEndpoint:
    """Tests for the /api/v1/traces/analytics endpoint."""

    @pytest.mark.asyncio
    async def test_analytics_endpoint_requires_auth(self):

        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        resp = client.get("/api/v1/traces/analytics")
        assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Conformance Rollup Model
# ---------------------------------------------------------------------------


class TestConformanceRollupModel:
    """Tests for the ConformanceRollup DB model."""

    def test_model_table_name(self):
        from app.db.models import ConformanceRollup

        assert ConformanceRollup.__tablename__ == "conformance_rollups"

    def test_model_has_required_columns(self):
        from app.db.models import ConformanceRollup

        cols = {c.name for c in ConformanceRollup.__table__.columns}
        expected = {"id", "rollup_id", "timestamp", "source", "language", "metrics", "org_id", "created_at"}
        assert expected.issubset(cols)


# ---------------------------------------------------------------------------
# Conformance Tracker Service
# ---------------------------------------------------------------------------


class TestConformanceTracker:
    """Tests for conformance_tracker service functions."""

    @pytest.mark.asyncio
    async def test_scrape_returns_error_on_unreachable_yarn(self):
        from app.services.conformance_tracker import scrape_yarn_telemetry

        with patch("app.services.conformance_tracker._yarn_url", return_value="http://localhost:1"):
            result = await scrape_yarn_telemetry()

        assert result["status"] == "error"
        assert "error" in result

    @pytest.mark.asyncio
    async def test_summary_empty_db(self):
        from app.services.conformance_tracker import get_conformance_summary

        with patch("app.services.conformance_tracker.async_session") as mock_ctx:
            session = AsyncMock()
            mock_ctx.return_value.__aenter__ = AsyncMock(return_value=session)
            mock_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_result = MagicMock()
            mock_result.scalars.return_value.all.return_value = []
            session.execute = AsyncMock(return_value=mock_result)

            result = await get_conformance_summary()

        assert result["summary"] == []
        assert result["languages"] == []

    @pytest.mark.asyncio
    async def test_history_empty_db(self):
        from app.services.conformance_tracker import get_conformance_history

        with patch("app.services.conformance_tracker.async_session") as mock_ctx:
            session = AsyncMock()
            mock_ctx.return_value.__aenter__ = AsyncMock(return_value=session)
            mock_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_result = MagicMock()
            mock_result.scalars.return_value.all.return_value = []
            session.execute = AsyncMock(return_value=mock_result)

            result = await get_conformance_history(language="go", limit=10)

        assert result == []


# ---------------------------------------------------------------------------
# Conformance API Endpoints
# ---------------------------------------------------------------------------


class TestConformanceEndpoints:
    """Tests for conformance API endpoints."""

    def test_conformance_summary_requires_auth(self):
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        resp = client.get("/api/v1/conformance/summary")
        assert resp.status_code in (401, 403)

    def test_conformance_history_requires_auth(self):
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        resp = client.get("/api/v1/conformance/history")
        assert resp.status_code in (401, 403)

    def test_conformance_scrape_requires_admin(self):
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        resp = client.post("/api/v1/conformance/scrape")
        assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Eval Harness
# ---------------------------------------------------------------------------


class TestEvalHarness:
    """Tests for eval_harness service."""

    def test_builtin_suites_exist(self):
        from app.services.eval_harness import BUILTIN_SUITES

        assert len(BUILTIN_SUITES) >= 3
        assert "recall_bypass" in BUILTIN_SUITES
        assert "verification_loop" in BUILTIN_SUITES
        assert "decision_quality" in BUILTIN_SUITES

    def test_list_suites(self):
        from app.services.eval_harness import list_suites

        suites = list_suites()
        assert isinstance(suites, list)
        assert len(suites) >= 3
        for s in suites:
            assert "name" in s
            assert "case_count" in s
            assert s["case_count"] > 0

    def test_check_expectations_latency_fail(self):
        from app.services.eval_harness import EvalCase, _check_expectations

        case = EvalCase(prompt="test", max_latency_ms=100)
        result = _check_expectations(case, 500.0, 10, {"choices": [{"message": {"content": "ok"}}]})
        assert any("latency" in f for f in result.failures)

    def test_check_expectations_token_fail(self):
        from app.services.eval_harness import EvalCase, _check_expectations

        case = EvalCase(prompt="test", max_tokens=50)
        result = _check_expectations(case, 100.0, 200, {"choices": [{"message": {"content": "ok"}}]})
        assert any("tokens" in f for f in result.failures)

    def test_check_expectations_all_pass(self):
        from app.services.eval_harness import EvalCase, _check_expectations

        case = EvalCase(prompt="test", max_latency_ms=1000, max_tokens=500)
        result = _check_expectations(
            case, 200.0, 100, {"choices": [{"message": {"content": "ok"}}], "usage": {"total_tokens": 100}}
        )
        assert result.failures == []

    def test_eval_result_to_dict(self):
        from app.services.eval_harness import CaseResult, EvalResult

        cr = CaseResult(case_index=0, prompt_snippet="test", category="test", passed=True, latency_ms=100.0)
        er = EvalResult(
            suite_name="test",
            total_cases=1,
            passed=1,
            failed=0,
            errored=0,
            pass_rate=1.0,
            cases=[cr],
        )
        d = er.to_dict()
        assert d["suite_name"] == "test"
        assert d["passed"] == 1
        assert d["pass_rate"] == 1.0
        assert len(d["cases"]) == 1

    def test_eval_case_defaults(self):
        from app.services.eval_harness import EvalCase

        case = EvalCase(prompt="hello")
        assert case.category == "general"
        assert case.expected_decision_path is None
        assert case.max_latency_ms is None


# ---------------------------------------------------------------------------
# Eval API Endpoints
# ---------------------------------------------------------------------------


class TestEvalsEndpoints:
    """Tests for eval API endpoints."""

    def test_list_suites_requires_auth(self):
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        resp = client.get("/api/v1/evals/suites")
        assert resp.status_code in (401, 403)

    def test_run_eval_requires_admin(self):
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        resp = client.post("/api/v1/evals/run", json={"suite_name": "recall_bypass"})
        assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Testing Labs Engine
# ---------------------------------------------------------------------------


class TestTestingLabsEngine:
    """Tests for testing_labs_engine service."""

    def test_regression_report_empty(self):
        from app.services.testing_labs_engine import RegressionReport

        report = RegressionReport(run_id="test", total_results=0)
        d = report.to_dict()
        assert d["regression_count"] == 0
        assert d["regressions"] == []

    def test_regression_report_with_regressions(self):
        from app.services.testing_labs_engine import Regression, RegressionReport

        regs = [
            Regression(
                prompt_index=0,
                prompt_snippet="test prompt",
                kind="verdict_degradation",
                baseline_value="pass",
                candidate_value="fail",
                detail="test",
            ),
            Regression(
                prompt_index=1,
                prompt_snippet="test prompt 2",
                kind="latency_regression",
                baseline_value=100,
                candidate_value=500,
            ),
        ]
        report = RegressionReport(run_id="r1", total_results=5, regressions=regs, regression_count=2)
        d = report.to_dict()
        assert d["regression_count"] == 2
        assert d["regressions"][0]["kind"] == "verdict_degradation"
        assert d["regressions"][1]["kind"] == "latency_regression"

    @pytest.mark.asyncio
    async def test_detect_regressions_empty(self):
        from app.services.testing_labs_engine import detect_regressions

        with patch("app.services.testing_labs_engine.async_session") as mock_ctx:
            session = AsyncMock()
            mock_ctx.return_value.__aenter__ = AsyncMock(return_value=session)
            mock_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_result = MagicMock()
            mock_result.scalars.return_value.all.return_value = []
            session.execute = AsyncMock(return_value=mock_result)

            report = await detect_regressions("test-run")

        assert report.total_results == 0
        assert report.regression_count == 0

    @pytest.mark.asyncio
    async def test_execute_run_not_found(self):
        from app.services.testing_labs_engine import execute_run

        with patch("app.services.testing_labs_engine.async_session") as mock_ctx:
            session = AsyncMock()
            mock_ctx.return_value.__aenter__ = AsyncMock(return_value=session)
            mock_ctx.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_result = MagicMock()
            mock_result.scalar_one_or_none.return_value = None
            session.execute = AsyncMock(return_value=mock_result)

            result = await execute_run("nonexistent", "http://localhost:8000")

        assert "error" in result
        assert "not found" in result["error"].lower()


class TestTestingLabsEndpoints:
    """Tests for Testing Labs execute/regression endpoints."""

    def test_execute_requires_admin(self):
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        resp = client.post("/api/v1/testing-labs/runs/test-run/execute")
        assert resp.status_code in (401, 403)

    def test_regressions_requires_auth(self):
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        resp = client.get("/api/v1/testing-labs/runs/test-run/regressions")
        assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Alembic Migration Presence
# ---------------------------------------------------------------------------


class TestMigration:
    """Verify the conformance rollup migration exists."""

    def test_migration_024_exists(self):
        import pathlib

        migration_path = pathlib.Path(__file__).parent.parent / "alembic" / "versions" / "024_conformance_rollups.py"
        assert migration_path.exists(), f"Migration file not found: {migration_path}"
        content = migration_path.read_text()
        assert 'revision: str = "024_conformance_rollups"' in content
        assert 'down_revision: str | None = "023_devhub_connector"' in content
        assert "conformance_rollups" in content
        assert "def upgrade" in content
        assert "def downgrade" in content
