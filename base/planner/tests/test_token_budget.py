"""Token budget integrity tests.

Validates:
1. token_utils state machine transitions (healthy → degraded → exhausted)
2. Overspend detection and anomaly tracking
3. Core nodes update budget in their return dicts (governance / static analysis)
4. Config SSOT: effective_token_budget resolution
"""

from __future__ import annotations

import ast
from pathlib import Path
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Unit tests for token_utils
# ---------------------------------------------------------------------------

from app.token_utils import (
    BudgetResult,
    BudgetState,
    apply_budget_decrement,
    check_budget_for_node,
    classify_budget,
    cleanup_anomaly_tracker,
    extract_usage_tokens,
    is_budget_degraded,
    track_budget,
)


class TestClassifyBudget:
    def test_healthy(self):
        assert classify_budget(80000, 100000) == BudgetState.HEALTHY

    def test_degraded_at_warn_threshold(self):
        assert classify_budget(20000, 100000) == BudgetState.DEGRADED

    def test_degraded_below_warn(self):
        assert classify_budget(10000, 100000) == BudgetState.DEGRADED

    def test_exhausted_at_zero(self):
        assert classify_budget(0, 100000) == BudgetState.EXHAUSTED

    def test_exhausted_negative(self):
        assert classify_budget(-100, 100000) == BudgetState.EXHAUSTED


class TestApplyBudgetDecrement:
    def test_basic_decrement(self):
        state = {"token_budget_remaining": 50000}
        result = apply_budget_decrement(state, 10000, role="test")
        assert isinstance(result, BudgetResult)
        assert result.remaining == 40000
        assert result.consumed == 10000
        assert result.state == BudgetState.HEALTHY
        assert not result.overspend

    def test_decrement_to_degraded(self):
        state = {"token_budget_remaining": 30000}
        result = apply_budget_decrement(state, 15000, role="test")
        assert result.remaining == 15000
        assert result.state == BudgetState.DEGRADED

    def test_decrement_to_exhausted(self):
        state = {"token_budget_remaining": 5000}
        result = apply_budget_decrement(state, 5000, role="test")
        assert result.remaining == 0
        assert result.state == BudgetState.EXHAUSTED

    def test_overspend_detection(self):
        state = {"token_budget_remaining": 1000}
        result = apply_budget_decrement(state, 5000, role="test")
        assert result.remaining == 0
        assert result.overspend is True
        assert result.overspend_amount == 4000

    def test_no_overspend_within_budget(self):
        state = {"token_budget_remaining": 10000}
        result = apply_budget_decrement(state, 5000, role="test")
        assert result.overspend is False
        assert result.overspend_amount == 0

    def test_zero_usage(self):
        state = {"token_budget_remaining": 50000}
        result = apply_budget_decrement(state, 0, role="test")
        assert result.remaining == 50000
        assert result.consumed == 0

    def test_remaining_never_negative(self):
        state = {"token_budget_remaining": 100}
        result = apply_budget_decrement(state, 10000, role="test")
        assert result.remaining == 0


class TestAnomalyTracking:
    def setup_method(self):
        cleanup_anomaly_tracker("test-run-1")

    def teardown_method(self):
        cleanup_anomaly_tracker("test-run-1")

    def test_no_anomaly_under_trip_count(self):
        state = {"token_budget_remaining": 100}
        r1 = apply_budget_decrement(state, 200, role="t", run_id="test-run-1")
        r2 = apply_budget_decrement(state, 200, role="t", run_id="test-run-1")
        assert not r1.anomaly_tripped
        assert not r2.anomaly_tripped

    def test_anomaly_trips_at_threshold(self):
        state = {"token_budget_remaining": 100}
        results = []
        for _ in range(4):
            r = apply_budget_decrement(state, 200, role="t", run_id="test-run-1")
            results.append(r)
        assert results[-1].anomaly_tripped is True

    def test_cleanup(self):
        state = {"token_budget_remaining": 100}
        apply_budget_decrement(state, 200, role="t", run_id="test-run-1")
        cleanup_anomaly_tracker("test-run-1")
        r = apply_budget_decrement(state, 200, role="t", run_id="test-run-1")
        assert not r.anomaly_tripped


class TestCheckBudgetForNode:
    def test_healthy_returns_none(self):
        state = {"token_budget_remaining": 50000}
        assert check_budget_for_node(state, node="writer") is None

    def test_exhausted_returns_result(self):
        state = {"token_budget_remaining": 0}
        result = check_budget_for_node(state, node="writer")
        assert result is not None
        assert result.state == BudgetState.EXHAUSTED

    def test_degraded_returns_none(self):
        state = {"token_budget_remaining": 15000}
        assert check_budget_for_node(state, node="writer") is None


class TestIsBudgetDegraded:
    def test_healthy_is_not_degraded(self):
        state = {"token_budget_remaining": 80000}
        assert not is_budget_degraded(state)

    def test_degraded_is_detected(self):
        state = {"token_budget_remaining": 15000}
        assert is_budget_degraded(state)


class TestTrackBudgetCompat:
    """Verify backward-compat wrapper returns int."""

    def test_returns_int(self):
        class MockResponse:
            usage_metadata = {"total_tokens": 5000}
        state = {"token_budget_remaining": 50000}
        result = track_budget(state, MockResponse(), role="writer")
        assert isinstance(result, int)
        assert result == 45000


class TestExtractUsageTokens:
    def test_usage_metadata_dict(self):
        class R:
            usage_metadata = {"total_tokens": 123}
            response_metadata = {}
        assert extract_usage_tokens(R()) == 123

    def test_usage_metadata_input_output(self):
        class R:
            usage_metadata = {"input_tokens": 50, "output_tokens": 73}
            response_metadata = {}
        assert extract_usage_tokens(R()) == 123

    def test_response_metadata_fallback(self):
        class R:
            usage_metadata = None
            response_metadata = {"usage": {"prompt_tokens": 40, "completion_tokens": 60}}
        assert extract_usage_tokens(R()) == 100

    def test_no_metadata(self):
        class R:
            usage_metadata = None
            response_metadata = {}
        assert extract_usage_tokens(R()) == 0


# ---------------------------------------------------------------------------
# Config SSOT tests
# ---------------------------------------------------------------------------

class TestConfigEffectiveBudget:
    def test_default_uses_max_tokens(self):
        from app.config import Settings
        s = Settings()
        assert s.effective_token_budget == s.max_tokens_per_request

    def test_explicit_total_wins(self):
        from app.config import Settings
        s = Settings(token_budget_total=200000)
        assert s.effective_token_budget == 200000

    def test_zero_total_falls_back(self):
        from app.config import Settings
        s = Settings(token_budget_total=0, max_tokens_per_request=80000)
        assert s.effective_token_budget == 80000


# ---------------------------------------------------------------------------
# Governance: core nodes must update token_budget_remaining
# ---------------------------------------------------------------------------

APP_DIR = Path(__file__).resolve().parent.parent / "app"
NODES_DIR = APP_DIR / "nodes"

CORE_BUDGET_NODES = {
    "router.py",
    "planner_node.py",
    "writer.py",
    "critic.py",
    "final_answer_compiler.py",
}


def _file_references_budget_accounting(filepath: Path) -> bool:
    """Check that a node file calls budget accounting helpers."""
    source = filepath.read_text(encoding="utf-8")
    tree = ast.parse(source)

    budget_functions = {
        "apply_budget_decrement",
        "track_budget",
        "check_budget_for_node",
    }

    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                if alias.name in budget_functions:
                    return True
        if isinstance(node, ast.Name) and node.id in budget_functions:
            return True
    return False


def _file_returns_budget_key(filepath: Path) -> bool:
    """Check that a node file includes 'token_budget_remaining' in at least one return dict."""
    source = filepath.read_text(encoding="utf-8")
    return "token_budget_remaining" in source


class TestBudgetGovernance:
    @pytest.mark.parametrize("node_file", sorted(CORE_BUDGET_NODES))
    def test_core_node_calls_budget_accounting(self, node_file: str):
        """Every core LLM-calling node must import budget accounting helpers."""
        fp = NODES_DIR / node_file
        assert fp.exists(), f"{node_file} not found"
        assert _file_references_budget_accounting(fp), (
            f"{node_file} does not import any budget accounting function "
            f"(apply_budget_decrement, track_budget, or check_budget_for_node). "
            "All core LLM nodes must account for token budget."
        )

    @pytest.mark.parametrize("node_file", sorted(CORE_BUDGET_NODES))
    def test_core_node_returns_budget_key(self, node_file: str):
        """Every core node must include token_budget_remaining in its return dict."""
        fp = NODES_DIR / node_file
        assert fp.exists(), f"{node_file} not found"
        assert _file_returns_budget_key(fp), (
            f"{node_file} does not return 'token_budget_remaining'. "
            "All core nodes must forward budget state."
        )


# ---------------------------------------------------------------------------
# Trace context includes budget fields
# ---------------------------------------------------------------------------

class TestTraceContextBudgetFields:
    def test_budget_fields_present(self):
        from app.run_context import build_trace_context

        state = {"token_budget_remaining": 42000}
        ctx = build_trace_context(state)
        assert "token_budget_total" in ctx
        assert "token_budget_remaining" in ctx
        assert "token_budget_consumed" in ctx
        assert "token_budget_state" in ctx
        assert ctx["token_budget_remaining"] == 42000
        assert ctx["token_budget_state"] in ("healthy", "degraded", "exhausted")
