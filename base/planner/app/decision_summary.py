"""Decision Summary — JCS UX: surface "why this approach" without exposing internals.

Taxonomy-aware: uses intent_class × vertical to pick evidence sources and uncertain keys.
- Code: lint, sandbox, LSP, RAG; revision_strategy; what_ifs, residual_risks
- Knowledge: RAG; residual_risks, knowledge_gap_message
- Lifestyle: RAG; residual_risks, assumptions
- Planning: RAG, execution_plan; residual_risks
"""

from __future__ import annotations

from typing import Any


def _get_intent_and_vertical(state: dict[str, Any]) -> tuple[str, str]:
    """Resolve intent_class and vertical for taxonomy-aware summary."""
    intent = state.get("intent_class", "code")
    try:
        from .vertical_resolver import resolve_active_vertical

        vertical = resolve_active_vertical(
            state.get("active_domain_refs"),
            state.get("platform_context"),
        )
    except Exception:
        vertical = "generic"
    return intent, vertical


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
    """Build taxonomy-aware Decision Summary. Returns None if nothing substantive."""

    intent_class, vertical = _get_intent_and_vertical(state)
    approach_label = ""
    try:
        from .approach_dark_debt import get_approach_semantics, get_how_i_got_here_sources

        sources = get_how_i_got_here_sources(intent_class)
        approach = get_approach_semantics(intent_class, vertical, state.get("task_size", ""))
        approach_label = approach.get("label", "")
    except ImportError:
        sources = {"evidence": ["sandbox", "lsp", "rag"], "strategy_key": "revision_strategy", "uncertain_key": ["what_if_analyses", "residual_risks"]}

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
    evidence_keys = sources.get("evidence", ["sandbox", "lsp", "rag"])
    strategy_key = sources.get("strategy_key")
    uncertain_keys = sources.get("uncertain_key", ["what_if_analyses", "residual_risks"])
    if isinstance(uncertain_keys, str):
        uncertain_keys = [k.strip() for k in uncertain_keys.split(",") if k.strip()]

    bullets: list[str] = []

    # 0. Approach taken (taxonomy-aware)
    if approach_label:
        bullets.append(f"**Approach:** {approach_label}")

    # 1. Selected strategy + why (code/debugging: revision cycle)
    if strategy_key and iteration > 0 and revision_strategy and strategy_candidates:
        why = _strategy_why(revision_strategy, strategy_candidates)
        bullets.append(f"**Strategy:** {revision_strategy.replace('_', ' ')} — {why}")

    # 2. Alternatives considered (code)
    if strategy_candidates and revision_strategy:
        others = [
            c.get("name", "").replace("_", " ")
            for c in strategy_candidates
            if isinstance(c, dict) and c.get("name") != revision_strategy
        ][:2]
        if others:
            bullets.append(f"**Also considered:** {', '.join(others)}")

    # 3. Evidence highlights (taxonomy-aware)
    evidence_parts: list[str] = []
    if "sandbox" in evidence_keys and exit_code is not None:
        if exit_code == 0:
            evidence_parts.append("runtime ✓")
        else:
            if lint_passed:
                evidence_parts.append("lint ✓")
            if security_passed:
                evidence_parts.append("security ✓")
    if "lsp" in evidence_keys and lsp_diagnostics:
        evidence_parts.append("LSP ✓")
    if "rag" in evidence_keys and rag_collections:
        evidence_parts.append("RAG ✓")
    if "execution_plan" in evidence_keys and state.get("execution_plan"):
        evidence_parts.append("plan ✓")

    if evidence_parts:
        bullets.append(f"**Checked:** {' · '.join(evidence_parts)}")

    # 4. What remains uncertain (taxonomy-aware)
    uncertain: list[str] = []
    for key in uncertain_keys:
        if key == "residual_risks":
            for r in residual_risks:
                if isinstance(r, dict) and r.get("scenario"):
                    uncertain.append(str(r.get("scenario", ""))[:80])
        elif key == "what_if_analyses":
            for w in what_ifs:
                risk = getattr(w, "risk_level", "medium")
                if risk in ("high", "critical"):
                    scenario = getattr(w, "scenario", str(w))[:60]
                    mitigation = getattr(w, "suggested_mitigation", "")
                    if not mitigation:
                        uncertain.append(scenario)
        elif key == "knowledge_gap_message":
            kg = (state.get("knowledge_gap_message") or "").strip()
            if kg:
                uncertain.append(kg[:80])
        elif key == "assumptions":
            for a in (state.get("assumptions") or [])[:2]:
                if a:
                    uncertain.append(str(a)[:60])
    uncertain = list(dict.fromkeys(uncertain))[:3]

    if uncertain:
        bullets.append(f"**Uncertain:** {'; '.join(uncertain)}")

    if not bullets:
        return None

    return "\n".join(f"- {b}" for b in bullets)
