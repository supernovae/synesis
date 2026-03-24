"""Token estimation, budget tracking, and hybrid enforcement utilities.

Provides:
- Model-aware token counting (tiktoken when available, fallback heuristic).
- Structured budget accounting with state classification (healthy/degraded/exhausted).
- Overspend anomaly detection via rolling window.
- Hybrid enforcement: soft degrade at warning threshold, hard stop at zero.

Configuration lives in ``config.Settings`` (single source of truth).
"""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

logger = logging.getLogger("synesis.token_utils")

_tokenizer_cache: dict[str, Any] = {}


# ---------------------------------------------------------------------------
# Budget state enum
# ---------------------------------------------------------------------------

class BudgetState(str, Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    EXHAUSTED = "exhausted"


# ---------------------------------------------------------------------------
# Structured result from budget accounting
# ---------------------------------------------------------------------------

@dataclass
class BudgetResult:
    """Returned by ``apply_budget_decrement``."""
    remaining: int
    consumed: int
    total_budget: int
    state: BudgetState
    overspend: bool = False
    overspend_amount: int = 0
    anomaly_tripped: bool = False


# ---------------------------------------------------------------------------
# Per-request anomaly tracker (rolling window)
# ---------------------------------------------------------------------------

@dataclass
class _AnomalyTracker:
    window_size: int = 5
    trip_count: int = 3
    _recent: deque = field(default_factory=deque)

    def record(self, overspend: bool) -> bool:
        """Record whether a call overspent; return True if anomaly trips."""
        self._recent.append(overspend)
        while len(self._recent) > self.window_size:
            self._recent.popleft()
        return sum(self._recent) >= self.trip_count

    def reset(self) -> None:
        self._recent.clear()


_request_anomaly_trackers: dict[str, _AnomalyTracker] = {}


def _get_anomaly_tracker(run_id: str) -> _AnomalyTracker:
    from .config import settings
    if run_id not in _request_anomaly_trackers:
        _request_anomaly_trackers[run_id] = _AnomalyTracker(
            window_size=settings.token_budget_anomaly_window,
            trip_count=settings.token_budget_anomaly_trip_count,
        )
    return _request_anomaly_trackers[run_id]


def cleanup_anomaly_tracker(run_id: str) -> None:
    """Remove tracker for a completed request to avoid unbounded growth."""
    _request_anomaly_trackers.pop(run_id, None)


# ---------------------------------------------------------------------------
# Token estimation
# ---------------------------------------------------------------------------

def estimate_tokens(text: str, model: str = "") -> int:
    """Estimate token count for *text*.

    Tries tiktoken encoding for known model families first.
    Falls back to ``len(text) // 4`` which averages ~25% error.
    """
    if not text:
        return 0

    enc = _get_tokenizer(model)
    if enc is not None:
        try:
            return len(enc.encode(text))
        except Exception:
            pass

    return len(text) // 4


def _get_tokenizer(model: str) -> Any:
    """Return a tiktoken encoding for *model*, or None."""
    if not model:
        return None

    if model in _tokenizer_cache:
        return _tokenizer_cache[model]

    try:
        import tiktoken

        try:
            enc = tiktoken.encoding_for_model(model)
        except KeyError:
            enc = tiktoken.get_encoding("cl100k_base")
        _tokenizer_cache[model] = enc
        return enc
    except ImportError:
        _tokenizer_cache[model] = None
        return None


# ---------------------------------------------------------------------------
# Usage extraction
# ---------------------------------------------------------------------------

def extract_usage_tokens(response: Any) -> int:
    """Extract total token usage from a LangChain AIMessage or response object."""
    meta = getattr(response, "usage_metadata", None)
    if meta:
        if isinstance(meta, dict):
            total = meta.get("total_tokens", 0)
            if not total:
                total = meta.get("input_tokens", 0) + meta.get("output_tokens", 0)
            return int(total or 0)
        total = int(getattr(meta, "total_tokens", 0) or 0)
        if not total:
            total = int(getattr(meta, "input_tokens", 0) or 0) + int(getattr(meta, "output_tokens", 0) or 0)
        return total
    resp_meta = getattr(response, "response_metadata", {})
    usage = resp_meta.get("usage", {}) if isinstance(resp_meta, dict) else {}
    total = int(usage.get("total_tokens", 0))
    if not total:
        total = int(usage.get("prompt_tokens", 0)) + int(usage.get("completion_tokens", 0))
    return total


# ---------------------------------------------------------------------------
# Budget state classification
# ---------------------------------------------------------------------------

def classify_budget(remaining: int, total: int) -> BudgetState:
    """Classify budget into healthy / degraded / exhausted."""
    from .config import settings

    if remaining <= 0:
        return BudgetState.EXHAUSTED
    fraction_remaining = remaining / max(total, 1)
    if fraction_remaining <= settings.token_budget_warn_pct:
        return BudgetState.DEGRADED
    return BudgetState.HEALTHY


# ---------------------------------------------------------------------------
# Core accounting primitive
# ---------------------------------------------------------------------------

def apply_budget_decrement(
    state: dict,
    used: int,
    *,
    role: str = "",
    run_id: str = "",
) -> BudgetResult:
    """Decrement budget and return structured result with state + anomaly flags.

    This is the single accounting entry point. All LLM-calling nodes must
    route through here for consistent enforcement and telemetry.
    """
    from .config import settings

    total = settings.effective_token_budget
    remaining = state.get("token_budget_remaining", total)
    new_remaining = max(0, remaining - used)

    tolerance = int(total * settings.token_budget_overspend_tolerance_pct)
    overspend = used > remaining
    overspend_amount = max(0, used - remaining)
    severe_overspend = overspend_amount > tolerance

    anomaly_tripped = False
    if run_id and overspend:
        tracker = _get_anomaly_tracker(run_id)
        anomaly_tripped = tracker.record(True)
    elif run_id:
        tracker = _get_anomaly_tracker(run_id)
        tracker.record(False)

    budget_state = classify_budget(new_remaining, total)

    if used > 0:
        logger.debug(
            "token_budget_update",
            extra={
                "role": role,
                "used": used,
                "remaining": new_remaining,
                "state": budget_state.value,
                "overspend": overspend,
                "overspend_amount": overspend_amount,
                "anomaly_tripped": anomaly_tripped,
            },
        )
    if severe_overspend:
        logger.warning(
            "token_budget_severe_overspend",
            extra={
                "role": role,
                "used": used,
                "remaining_before": remaining,
                "tolerance": tolerance,
                "overspend_amount": overspend_amount,
            },
        )

    from .api_metrics import record_budget_anomaly_trip, record_budget_overspend
    if overspend and role:
        record_budget_overspend(role)
    if anomaly_tripped:
        record_budget_anomaly_trip()

    return BudgetResult(
        remaining=new_remaining,
        consumed=used,
        total_budget=total,
        state=budget_state,
        overspend=overspend,
        overspend_amount=overspend_amount,
        anomaly_tripped=anomaly_tripped,
    )


# ---------------------------------------------------------------------------
# Backward-compatible wrapper (used by nodes being migrated)
# ---------------------------------------------------------------------------

def track_budget(state: dict, response: Any, role: str = "") -> int:
    """Decrement token_budget_remaining using actual usage from response.

    Returns the new budget value (integer).  Nodes being migrated to the
    full ``apply_budget_decrement`` API can continue using this wrapper.
    """
    used = extract_usage_tokens(response)
    result = apply_budget_decrement(
        state,
        used,
        role=role,
        run_id=state.get("run_id", ""),
    )
    return result.remaining


# ---------------------------------------------------------------------------
# Enforcement helpers
# ---------------------------------------------------------------------------

def check_budget_for_node(state: dict, *, node: str) -> BudgetResult | None:
    """Pre-call check: if budget is exhausted, return a result signalling stop.

    Returns ``None`` if the node should proceed normally.
    """
    from .config import settings

    total = settings.effective_token_budget
    remaining = state.get("token_budget_remaining", total)
    budget_state = classify_budget(remaining, total)

    if budget_state == BudgetState.EXHAUSTED:
        logger.warning(
            "token_budget_hard_stop",
            extra={"node": node, "remaining": remaining},
        )
        return BudgetResult(
            remaining=remaining,
            consumed=0,
            total_budget=total,
            state=budget_state,
        )
    return None


def is_budget_degraded(state: dict) -> bool:
    """Return True when the budget is in degraded or exhausted state."""
    from .config import settings

    total = settings.effective_token_budget
    remaining = state.get("token_budget_remaining", total)
    return classify_budget(remaining, total) != BudgetState.HEALTHY


def record_request_budget_metrics(state: dict) -> None:
    """Emit end-of-request Prometheus budget metrics."""
    from .api_metrics import record_budget_degraded, record_budget_exhausted, record_budget_remaining
    from .config import settings

    total = settings.effective_token_budget
    remaining = state.get("token_budget_remaining", total)
    record_budget_remaining(remaining)
    budget_state = classify_budget(remaining, total)
    if budget_state == BudgetState.EXHAUSTED:
        record_budget_exhausted()
    elif budget_state == BudgetState.DEGRADED:
        record_budget_degraded()
