"""Auto effort-mode routing for planner.

Design goals:
- Reuse existing classifier/taxonomy/frame outputs.
- Avoid regex-heavy or unbounded rule chains.
- Keep routing O(1) over a fixed feature set.
"""

from __future__ import annotations

import re
from typing import Any

from .effort_modes import EffortMode, EffortRecommendation, RoutingSignals

_RISK_MARKERS = re.compile(
    r"\b(prod(?:uction)?|security|compliance|hipaa|pci|pii|customer[- ]?impact|outage|migration|rollback)\b",
    re.IGNORECASE,
)

_AMBIGUITY_MARKERS = re.compile(
    r"\b(maybe|perhaps|unsure|not sure|depends|roughly|something like|whatever works|can you suggest)\b",
    re.IGNORECASE,
)


def _clip01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _norm_score(value: Any, max_value: float = 100.0) -> float:
    try:
        return _clip01(float(value) / max_value)
    except (TypeError, ValueError):
        return 0.0


def _extract_signals(state: dict[str, Any], classified: dict[str, Any], frame: dict[str, Any] | None) -> RoutingSignals:
    text = (classified.get("task_description") or state.get("task_description") or "").strip()[:2000]
    taxonomy = classified.get("taxonomy_metadata") or {}
    active_domains = classified.get("active_domain_refs") or []
    domain_ref_counts = classified.get("domain_ref_counts") or {}

    complexity = _clip01(float(classified.get("difficulty", 0.5)))
    risk = _norm_score(classified.get("risk_score", 0), 100.0)
    if _RISK_MARKERS.search(text):
        risk = _clip01(risk + 0.15)

    ambiguity = 0.15
    if _AMBIGUITY_MARKERS.search(text):
        ambiguity += 0.25
    if text.endswith("?"):
        ambiguity += 0.1
    if isinstance(frame, dict) and not frame.get("semantic_frame"):
        ambiguity += 0.1
    ambiguity = _clip01(ambiguity)

    scope = _clip01(
        0.1
        + min(0.4, len(active_domains) * 0.07)
        + min(0.3, len(domain_ref_counts) * 0.03)
        + (0.15 if taxonomy else 0.0)
    )

    # Retrieval/tool-use expectation from current planner metadata.
    rag_mode = classified.get("rag_mode", "disabled")
    if rag_mode == "normal":
        user_intent = 0.8
    elif rag_mode == "light":
        user_intent = 0.5
    else:
        user_intent = 0.2

    # Placeholder for live health integration. 1.0 healthy, lower means degrade.
    operational_health = _clip01(float(state.get("operational_health_score", 1.0)))

    return RoutingSignals(
        complexity=complexity,
        ambiguity=ambiguity,
        risk=risk,
        scope=scope,
        user_intent=user_intent,
        operational_health=operational_health,
    )


def _recommend_from_signals(signals: RoutingSignals) -> tuple[EffortMode, float, list[str]]:
    pulse_score = (
        (1.0 - signals.complexity) * 0.45
        + (1.0 - signals.risk) * 0.30
        + (1.0 - signals.scope) * 0.15
        + signals.operational_health * 0.10
    )
    core_score = (
        (1.0 - abs(signals.complexity - 0.55)) * 0.40
        + (1.0 - abs(signals.risk - 0.45)) * 0.20
        + (1.0 - abs(signals.scope - 0.45)) * 0.20
        + signals.user_intent * 0.10
        + signals.operational_health * 0.10
    )
    horizon_score = (
        signals.complexity * 0.35
        + signals.risk * 0.30
        + signals.scope * 0.20
        + signals.ambiguity * 0.10
        + (1.0 - signals.operational_health) * 0.05
    )
    if signals.complexity >= 0.8 and (signals.risk >= 0.65 or signals.scope >= 0.6):
        horizon_score += 0.12
    scores: dict[EffortMode, float] = {
        "pulse": _clip01(pulse_score),
        "core": _clip01(core_score),
        "horizon": _clip01(horizon_score),
    }
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best_mode, best = ranked[0]
    second = ranked[1][1]
    confidence = _clip01(0.5 + (best - second))

    reasons: list[str] = []
    if signals.complexity >= 0.75:
        reasons.append("high_complexity")
    if signals.risk >= 0.65:
        reasons.append("high_risk")
    if signals.scope >= 0.6:
        reasons.append("broad_scope")
    if signals.ambiguity >= 0.55:
        reasons.append("high_ambiguity")
    if signals.complexity <= 0.25 and signals.risk <= 0.3:
        reasons.append("low_risk_simple")
    if signals.operational_health < 0.6:
        reasons.append("degraded_operational_health")

    return best_mode, confidence, reasons or ["balanced_default"]


def recommend_effort_mode(
    state: dict[str, Any],
    classified: dict[str, Any],
    frame: dict[str, Any] | None = None,
) -> EffortRecommendation:
    """Return effort recommendation from existing planner state.

    Manual mode override is handled by caller; this function is for "auto".
    """
    signals = _extract_signals(state, classified, frame)
    mode, confidence, reasons = _recommend_from_signals(signals)
    # Confidence gate for safer behavior, but preserve high-risk/high-complexity escalations.
    if confidence < 0.6 and not (
        signals.complexity >= 0.75 or signals.risk >= 0.65 or signals.scope >= 0.65
    ):
        mode = "core"
        reasons = reasons + ["low_confidence_fallback_to_core"]
    return EffortRecommendation(
        recommended_mode=mode,
        confidence=confidence,
        reasons=reasons,
        routing_signals=signals,
    )

