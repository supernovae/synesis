"""Critic policy engine — scoring, evidence gating, retry controller, monotonic invariants.

Implements critic_policy_spec.json. Plugs into the critic node.
Do NOT rename taxonomy classes or invent new critic modes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Literal

logger = logging.getLogger("synesis.critic_policy")

VALID_REF_TYPES = frozenset(("lsp", "sandbox"))


@dataclass
class EvidenceObject:
    """Normalized evidence from tool_refs. Maps to state.rag.evidence schema."""

    evidence_id: str
    source_type: str  # doc|web|log|user_input → map sandbox->sandbox, lsp->lsp, rag->doc
    source_ref: str  # request_id, doc id, etc.
    content: str = ""
    trust: dict[str, Any] = field(default_factory=lambda: {"score": 1.0, "notes": ""})
    timestamp: str | None = None


def tool_refs_to_evidence(tool_refs: list[dict[str, Any]]) -> list[EvidenceObject]:
    """Normalize tool_refs to evidence objects. Used for state.rag.evidence.

    evidence_id = {tool}_{request_id[:8]}
    """
    out: list[EvidenceObject] = []
    for tr in tool_refs or []:
        t = (
            tr
            if isinstance(tr, dict)
            else (getattr(tr, "model_dump", lambda: {})() if hasattr(tr, "model_dump") else {})
        )
        tool = t.get("tool", "unknown")
        req_id = (t.get("request_id") or "")[:8]
        if not req_id:
            continue
        evidence_id = f"{tool}_{req_id}"
        source_type = tool  # sandbox, lsp, rag
        source_ref = t.get("request_id", "")
        content = (t.get("result_summary") or "")[:200]
        trust = {"score": 0.9 if tool in ("sandbox", "lsp") else 0.7, "notes": "tool_output"}
        ts = t.get("created_at")
        out.append(
            EvidenceObject(
                evidence_id=evidence_id,
                source_type=source_type,
                source_ref=source_ref,
                content=content,
                trust=trust,
                timestamp=ts,
            )
        )
    return out


def get_available_evidence_ids(tool_refs: list[dict[str, Any]]) -> set[str]:
    """Set of evidence_id strings that exist. For evidence-gate validation."""
    ev = tool_refs_to_evidence(tool_refs or [])
    return {e.evidence_id for e in ev}


def check_evidence_gate(
    approved: bool,
    blocking_issues: list[Any],
    available_ids: set[str] | None = None,
) -> tuple[bool, bool]:
    """Evidence gate: approved=false requires >=1 blocking_issue with lsp/sandbox refs.

    Returns (effective_approved, has_valid_evidence).
    Override to approved if blocking without valid refs.
    """
    if approved:
        return True, True
    if not blocking_issues:
        return False, False
    has_evidence = False
    for bi in blocking_issues:
        refs = getattr(bi, "evidence_refs", []) if not isinstance(bi, dict) else bi.get("evidence_refs", [])
        for ref in refs or []:
            ref_type = ref.get("ref_type", "") if isinstance(ref, dict) else getattr(ref, "ref_type", "")
            if ref_type in VALID_REF_TYPES:
                has_evidence = True
                break
        if has_evidence:
            break
    if not has_evidence:
        return True, False  # Override to approved (no valid evidence for blocking)
    return False, True


def build_retry_state(state: dict[str, Any]) -> dict[str, Any]:
    """Build retry sub-object from existing state. Monotonic view.

    Maps: iteration_count->attempt, revision_strategies_tried->diversification_history,
    revision_constraints->constraints, failure_ids_seen/failure_type->failures.
    """
    attempt = state.get("iteration_count", 0)
    max_attempts = state.get("max_iterations", 3)
    failures = []
    ft = state.get("failure_type")
    fids = state.get("failure_ids_seen") or []
    if ft:
        for fid in fids[-5:]:  # Last 5
            failures.append({"failure_id": fid, "failure_type": ft})
    if not failures and ft:
        failures.append({"failure_type": ft})

    return {
        "attempt": attempt,
        "max_attempts": max_attempts,
        "failures": failures,
        "used_evidence_ids": [],  # Populated when we track citations
        "decisions": [],  # Append-only; from critic history
        "diversification_history": list(state.get("revision_strategies_tried") or []),
        "escalations": [],
        "constraints": dict(state.get("revision_constraints") or {}),
    }


def retry_state_updates(
    state: dict[str, Any],
    decision: Literal["PASS", "RETRY", "FAIL"],
    rationale: str,
    failure_type: str | None = None,
    failure_id: str | None = None,
    used_evidence_ids: list[str] | None = None,
    diversification: str | None = None,
) -> dict[str, Any]:
    """Produce state delta for monotonic retry updates. Append-only.

    Caller merges these into state. Never deletes prior entries.
    """
    out: dict[str, Any] = {}
    # Decisions: append
    decisions = list(state.get("retry", {}).get("decisions", []))
    decisions.append({"decision": decision, "rationale": rationale})
    out.setdefault("retry", {})["decisions"] = decisions

    if failure_type and failure_id:
        failures = list(state.get("retry", {}).get("failures", []))
        failures.append({"failure_id": failure_id, "failure_type": failure_type})
        out.setdefault("retry", {})["failures"] = failures

    if used_evidence_ids:
        used = list(state.get("retry", {}).get("used_evidence_ids", []))
        for eid in used_evidence_ids:
            if eid not in used:
                used.append(eid)
        out.setdefault("retry", {})["used_evidence_ids"] = used

    if diversification:
        hist = list(state.get("retry", {}).get("diversification_history", []))
        if diversification not in hist:
            hist.append(diversification)
        out.setdefault("retry", {})["diversification_history"] = hist

    return out


def select_diversification_strategy(
    strategy_candidates: list[dict[str, Any]],
    revision_strategies_tried: list[str],
) -> str | None:
    """Pick next revision strategy not yet tried. Deterministic."""
    tried = set(revision_strategies_tried or [])
    for cand in strategy_candidates or []:
        name = cand.get("name") or cand.get("strategy") if isinstance(cand, dict) else str(cand)
        if name and name not in tried:
            return name
    return None


def should_force_pass(attempt: int, max_attempts: int) -> bool:
    """Fail-fast: at max iterations, force PASS (degraded)."""
    return attempt >= max_attempts


def should_escalate(
    attempt: int,
    max_attempts: int,
    failure_type: str | None,
) -> bool:
    """Escalate when at max and failure pattern exists."""
    return attempt >= max_attempts and bool(failure_type)


def build_evidence_needed_query_plan(
    evidence_gap: str | None,
    intent_class: str,
) -> dict[str, Any]:
    """Emit retrieval query plan for needs_more_evidence. No tool calls.

    Supervisor/retrieval nodes consume this to run targeted RAG.
    """
    return {
        "reason": "needs_more_evidence",
        "evidence_gap": evidence_gap or "insufficient",
        "intent_class": intent_class,
        "query_plan": [
            {"target": "rag", "suggested_queries": [evidence_gap] if evidence_gap else ["context"]},
        ],
    }
