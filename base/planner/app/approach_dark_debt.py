"""Approach + Dark Debt + How I Got Here — universal across taxonomies.

Resolves (intent_class × vertical × task_size) → approach semantics,
dark-debt categories, and "How I got here" evidence sources.
See approach_dark_debt_config.yaml.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("synesis.approach_dark_debt")

_CONFIG_PATH = Path(__file__).parent.parent / "approach_dark_debt_config.yaml"
_cached: dict[str, Any] | None = None


def _load_config() -> dict[str, Any]:
    global _cached
    if _cached is not None:
        return _cached
    try:
        import yaml

        if _CONFIG_PATH.exists():
            with open(_CONFIG_PATH) as f:
                _cached = yaml.safe_load(f) or {}
        else:
            _cached = {}
    except Exception as e:
        logger.warning("approach_dark_debt_config_load_failed path=%s error=%s", _CONFIG_PATH, e)
        _cached = {}
    return _cached


def get_approach_semantics(
    intent_class: str,
    vertical: str,
    task_size: str = "",
) -> dict[str, Any]:
    """Resolve approach type and label for (intent × vertical × task_size)."""
    cfg = _load_config()
    mapping = cfg.get("intent_vertical_mapping") or {}
    approach_types = cfg.get("approach_types") or {}
    intent_map = mapping.get(intent_class) or mapping.get("code") or {}
    vert_cfg = intent_map.get(vertical) or intent_map.get("generic") or {}
    if isinstance(vert_cfg, dict):
        approach = vert_cfg.get("approach")
    else:
        approach = "direct_snippet"
    if isinstance(approach, list):
        # [A, B]: A = richer (complex), B = simpler (trivial). task_size picks.
        if task_size == "trivial" and len(approach) > 1:
            approach = approach[-1]  # e.g. direct_answer, quick_steps
        elif task_size == "complex" and len(approach) > 1:
            approach = approach[0]  # e.g. retrieval_augmented, structured_plan
        else:
            approach = approach[0] if approach else "direct_snippet"
    approach_types_map = (
        approach_types.get(intent_class)
        or approach_types.get(vertical)
        or approach_types.get("code")
        or {}
    )
    label = (
        approach_types_map.get(approach, str(approach).replace("_", " "))
        if isinstance(approach_types_map, dict)
        else str(approach)
    )
    task_modifiers = (cfg.get("common_relationships") or {}).get("task_size_modifiers") or {}
    modifier = task_modifiers.get(task_size, "")
    return {
        "approach_type": approach or "direct_snippet",
        "label": label,
        "task_size_modifier": modifier,
    }


def get_dark_debt_categories(
    intent_class: str,
    vertical: str,
) -> list[str]:
    """Return applicable dark_debt category keys for (intent × vertical)."""
    cfg = _load_config()
    mapping = cfg.get("intent_vertical_mapping") or {}
    intent_map = mapping.get(intent_class) or mapping.get("code") or {}
    vert_cfg = intent_map.get(vertical) or intent_map.get("generic") or {}
    if isinstance(vert_cfg, dict):
        dark_debt = vert_cfg.get("dark_debt")
    else:
        dark_debt = ["code_generic"]
    if isinstance(dark_debt, str):
        return [dark_debt]
    return list(dark_debt) if isinstance(dark_debt, list) else ["code_generic"]


def get_how_i_got_here_sources(intent_class: str) -> dict[str, Any]:
    """Return evidence keys and uncertain keys for 'How I got here'."""
    cfg = _load_config()
    sources = cfg.get("how_i_got_here_sources") or {}
    return sources.get(intent_class) or sources.get("code") or {"evidence": ["sandbox", "lsp", "rag"], "strategy_key": "revision_strategy", "uncertain_key": ["what_if_analyses", "residual_risks"]}


def build_universal_dark_debt_signal(
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
    """Build taxonomy-aware dark_debt_signal. Usable by critic and respond."""
    cats = get_dark_debt_categories(intent_class, vertical)
    approach = get_approach_semantics(intent_class, vertical, task_size)
    items: list[dict[str, Any]] = []

    # Legacy code-centric (at max iterations)
    if at_max_iterations and "code_generic" in cats:
        items.append({
            "category": "failure_at_max",
            "description": f"Forced approval at max iterations; failure pattern: {failure_type or 'runtime'}",
            "severity": "high",
            "vertical": vertical,
            "intent_class": intent_class,
        })
        if stages_passed is not None and stages_passed:
            items.append({
                "category": "stages_incomplete",
                "description": f"Stages passed: {', '.join(stages_passed)}",
                "severity": "medium",
                "vertical": vertical,
                "intent_class": intent_class,
            })

    # Knowledge gaps
    knowledge_gap = (state.get("knowledge_gap_message") or "").strip()
    if knowledge_gap and "knowledge" in cats:
        items.append({
            "category": "rag_confidence_low",
            "description": knowledge_gap[:200],
            "severity": "medium",
            "vertical": vertical,
            "intent_class": intent_class,
        })

    # Lifestyle: quick answer when plan might have been expected (only when we have other signal)
    if vertical == "lifestyle" and task_size in ("trivial", "small"):
        plan_required = state.get("plan_required", False)
        has_plan = bool(state.get("execution_plan"))
        if not plan_required and not has_plan and ("lifestyle_running" in cats or "lifestyle_nutrition" in cats):
            items.append({
                "category": "quick_answer_no_plan",
                "description": "Quick answer given; ask for a full plan (e.g. training program) if you need one",
                "severity": "low",
                "vertical": vertical,
                "intent_class": intent_class,
            })

    # Residual risks (generic)
    residual = state.get("residual_risks") or []
    for r in residual[:2]:
        if isinstance(r, dict) and r.get("scenario"):
            items.append({
                "category": "architecture_risk",
                "description": str(r.get("scenario", ""))[:150],
                "severity": "low",
                "vertical": vertical,
                "intent_class": intent_class,
            })

    out: dict[str, Any] = {
        "approach_taken": approach,
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
