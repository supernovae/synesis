"""Single place for critic turn kind and trace session/causal metadata (DRY)."""

from __future__ import annotations

from typing import Any, Literal

CriticTurnKind = Literal[
    "final",
    "interactive_continue",
    "micro_step",
    "skip",
]


def derive_critic_turn_kind(state: dict[str, Any]) -> CriticTurnKind:
    """Infer critic rubric from routing signals; default final."""
    if state.get("critic_turn_kind_override"):
        raw = str(state["critic_turn_kind_override"]).strip().lower()
        if raw in ("final", "interactive_continue", "micro_step", "skip"):
            return raw  # type: ignore[return-value]

    if state.get("pending_question_continue"):
        src = (state.get("pending_question_source") or "").strip().lower()
        if src in ("planner_clarification", "planner", "router", "writer", "executor"):
            return "interactive_continue"

    return "final"


def compute_trace_links(
    *,
    run_id: str,
    conversation_id: str | None,
    pending: dict[str, Any] | None,
) -> tuple[str | None, str | None, str]:
    """Return (parent_trace_id, root_trace_id, trace_root_id for state).

    When continuing a pending question, parent = origin run; root from pending chain.
    Otherwise this run starts a new root chain.
    """
    if pending:
        origin = (pending.get("origin_run_id") or pending.get("run_id") or "").strip()
        parent = origin if origin else None
        root = (pending.get("root_trace_id") or origin or run_id).strip()
        return parent, root, root
    return None, run_id, run_id


def build_trace_context(state: dict[str, Any]) -> dict[str, Any]:
    """Structured context embedded in full_record for analytics."""
    from .token_utils import BudgetState, classify_budget

    total_budget = 0
    try:
        from .config import settings
        total_budget = settings.effective_token_budget
    except Exception:
        pass
    remaining = state.get("token_budget_remaining", total_budget)
    budget_state = classify_budget(remaining, total_budget) if total_budget else BudgetState.HEALTHY
    err = (state.get("error") or "").strip() if isinstance(state.get("error"), str) else ""
    stop_reason = (state.get("stop_reason") or "").strip()
    failure_reason = err or stop_reason
    failure_stage = (state.get("current_node") or state.get("next_node") or "").strip()
    failure_type = ""
    if budget_state == BudgetState.EXHAUSTED:
        failure_type = "budget_exhausted"
    elif failure_reason:
        low = failure_reason.lower()
        if "timed out" in low or "timeout" in low:
            failure_type = "timeout"
        elif "auth" in low or "forbidden" in low or "unauthorized" in low:
            failure_type = "auth"
        else:
            failure_type = "runtime_error"

    return {
        "critic_turn_kind": derive_critic_turn_kind(state),
        "pending_question_continue": bool(state.get("pending_question_continue")),
        "pending_question_source": (state.get("pending_question_source") or "")[:64],
        "is_pivot": bool(state.get("is_pivot")),
        "plan_pending_approval": bool(state.get("plan_pending_approval")),
        "token_budget_total": total_budget,
        "token_budget_remaining": remaining,
        "token_budget_consumed": max(0, total_budget - remaining),
        "token_budget_state": budget_state.value,
        "budget_exhausted": budget_state == BudgetState.EXHAUSTED,
        "failure_stage": failure_stage[:64],
        "failure_type": failure_type,
        "failure_reason": failure_reason[:256],
    }
