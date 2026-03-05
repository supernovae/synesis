"""Carried Uncertainties — known unknowns surfaced to user/critic.

Simplified from former approach_dark_debt.py. Builds taxonomy-aware signal
for critic and respond nodes without the full approach/dark-debt config.
"""

from __future__ import annotations

from typing import Any


def build_universal_carried_uncertainties_signal(
    state: dict[str, Any],
    intent_class: str,
    vertical: str,
    task_size: str,
    *,
    at_max_iterations: bool = False,
    failure_type: str | None = None,
    task_desc: str = "",
    stages_passed: list[str] | None = None,
    suggested_system_fix: str | None = None,
) -> dict[str, Any]:
    """Build taxonomy-aware carried_uncertainties_signal."""
    items: list[dict[str, Any]] = []

    if at_max_iterations:
        items.append(
            {
                "category": "failure_at_max",
                "description": f"Forced approval at max iterations; failure pattern: {failure_type or 'runtime'}",
                "severity": "high",
                "vertical": vertical,
                "intent_class": intent_class,
            }
        )
        if stages_passed:
            items.append(
                {
                    "category": "stages_incomplete",
                    "description": f"Stages passed: {', '.join(stages_passed)}",
                    "severity": "medium",
                    "vertical": vertical,
                    "intent_class": intent_class,
                }
            )

    knowledge_gap = (state.get("knowledge_gap_message") or "").strip()
    if knowledge_gap:
        items.append(
            {
                "category": "rag_confidence_low",
                "description": knowledge_gap[:200],
                "severity": "medium",
                "vertical": vertical,
                "intent_class": intent_class,
            }
        )

    if vertical == "lifestyle" and task_size in ("easy", "medium"):
        plan_required = state.get("plan_required", False)
        has_plan = bool(state.get("execution_plan"))
        if not plan_required and not has_plan:
            items.append(
                {
                    "category": "quick_answer_no_plan",
                    "description": "Quick answer given; ask for a full plan if you need one",
                    "severity": "low",
                    "vertical": vertical,
                    "intent_class": intent_class,
                }
            )

    for r in (state.get("residual_risks") or [])[:2]:
        if isinstance(r, dict) and r.get("scenario"):
            items.append(
                {
                    "category": "architecture_risk",
                    "description": str(r.get("scenario", ""))[:150],
                    "severity": "low",
                    "vertical": vertical,
                    "intent_class": intent_class,
                }
            )

    out: dict[str, Any] = {
        "approach_taken": {},
        "items": items,
        "vertical": vertical,
        "intent_class": intent_class,
        "task_size": task_size,
        "failure_pattern": failure_type,
        "consistent_failures": at_max_iterations,
        "task_hint": (task_desc or "")[:200],
        "stages_passed": stages_passed or [],
    }
    if suggested_system_fix:
        out["suggested_system_fix"] = suggested_system_fix[:300]
    return out
