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
    cid = (conversation_id or "").strip() or None
    if pending:
        origin = (pending.get("origin_run_id") or pending.get("run_id") or "").strip()
        parent = origin if origin else None
        root = (pending.get("root_trace_id") or origin or run_id).strip()
        return parent, root, root
    return None, run_id, run_id


def build_trace_context(state: dict[str, Any]) -> dict[str, Any]:
    """Structured context embedded in full_record for analytics."""
    return {
        "critic_turn_kind": derive_critic_turn_kind(state),
        "pending_question_continue": bool(state.get("pending_question_continue")),
        "pending_question_source": (state.get("pending_question_source") or "")[:64],
        "is_pivot": bool(state.get("is_pivot")),
        "plan_pending_approval": bool(state.get("plan_pending_approval")),
    }
