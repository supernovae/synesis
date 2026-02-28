"""Decision Summary — JCS UX: surface "why this approach" without exposing internals.

Respond assembles a compact block from state:
- Selected strategy + why (1-3 bullets)
- Alternatives considered (2 max)
- Evidence highlights (lint, security, sandbox, LSP, RAG)
- What remains uncertain (residual_risks, high what_ifs without mitigation)
"""

from __future__ import annotations

from typing import Any


def _strategy_why(revision_strategy: str, strategy_candidates: list[dict]) -> str:
    """Get human-readable 'why' for the selected strategy."""
    for c in strategy_candidates:
        if isinstance(c, dict) and c.get("name") == revision_strategy:
            why = c.get("why", "")
            if why and why != "fallback":
                return why
    # Map strategy names to brief labels
    labels = {
        "minimal_fix": "targeted fix",
        "refactor": "broader restructuring",
        "revert_and_patch": "rollback and patch",
        "lsp_symbol_first": "type/symbol fixes first",
        "spec_alignment_first": "spec alignment first",
    }
    return labels.get(revision_strategy, revision_strategy.replace("_", " "))


def build_decision_summary(state: dict[str, Any]) -> str | None:
    """Build compact Decision Summary block. Returns None if nothing substantive."""

    revision_strategy = state.get("revision_strategy", "")
    strategy_candidates = state.get("strategy_candidates", [])
    iteration = state.get("iteration_count", 0)
    exit_code = state.get("execution_exit_code")
    lint_passed = state.get("execution_lint_passed", True)
    security_passed = state.get("execution_security_passed", True)
    lsp_diagnostics = state.get("lsp_diagnostics", [])
    rag_collections = state.get("rag_collections_queried", [])
    what_ifs = state.get("what_if_analyses", [])
    residual_risks = state.get("residual_risks", [])

    bullets: list[str] = []

    # 1. Selected strategy + why (only if we had a revision cycle)
    if iteration > 0 and revision_strategy and strategy_candidates:
        why = _strategy_why(revision_strategy, strategy_candidates)
        bullets.append(f"**Strategy:** {revision_strategy.replace('_', ' ')} — {why}")

    # 2. Alternatives considered (max 2)
    if strategy_candidates and revision_strategy:
        others = [
            c.get("name", "").replace("_", " ")
            for c in strategy_candidates
            if isinstance(c, dict) and c.get("name") != revision_strategy
        ][:2]
        if others:
            bullets.append(f"**Also considered:** {', '.join(others)}")

    # 3. Evidence highlights (compact)
    evidence_parts: list[str] = []
    if exit_code is not None:
        if exit_code == 0:
            evidence_parts.append("runtime ✓")
        elif lint_passed and security_passed:
            evidence_parts.append("lint ✓ security ✓")
        else:
            if lint_passed:
                evidence_parts.append("lint ✓")
            if security_passed:
                evidence_parts.append("security ✓")
    if lsp_diagnostics:
        evidence_parts.append("LSP ✓")
    if rag_collections:
        evidence_parts.append("RAG ✓")

    if evidence_parts:
        bullets.append(f"**Checked:** {' · '.join(evidence_parts)}")

    # 4. What remains uncertain
    uncertain: list[str] = []
    for r in residual_risks:
        if isinstance(r, dict) and r.get("scenario"):
            uncertain.append(str(r.get("scenario", ""))[:80])
    for w in what_ifs:
        risk = getattr(w, "risk_level", "medium")
        if risk in ("high", "critical"):
            scenario = getattr(w, "scenario", str(w))[:60]
            mitigation = getattr(w, "suggested_mitigation", "")
            if not mitigation:
                uncertain.append(scenario)
    uncertain = list(dict.fromkeys(uncertain))[:3]  # Dedupe, max 3

    if uncertain:
        bullets.append(f"**Uncertain:** {'; '.join(uncertain)}")

    if not bullets:
        return None

    return "\n".join(f"- {b}" for b in bullets)
