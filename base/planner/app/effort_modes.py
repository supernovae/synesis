"""Effort-mode domain contracts for planner/front-end model abstraction.

Effort modes are durable user-facing capability contracts, decoupled from
provider/model implementation details:
  - auto
  - pulse
  - core
  - horizon
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

EffortMode = Literal["auto", "pulse", "core", "horizon"]


@dataclass(frozen=True)
class RoutingSignals:
    complexity: float
    ambiguity: float
    risk: float
    scope: float
    user_intent: float
    operational_health: float


@dataclass(frozen=True)
class EffortRecommendation:
    recommended_mode: EffortMode
    confidence: float
    reasons: list[str]
    routing_signals: RoutingSignals

    def as_dict(self) -> dict[str, Any]:
        return {
            "recommended_mode": self.recommended_mode,
            "confidence": self.confidence,
            "reasons": list(self.reasons),
            "routing_signals": {
                "complexity": self.routing_signals.complexity,
                "ambiguity": self.routing_signals.ambiguity,
                "risk": self.routing_signals.risk,
                "scope": self.routing_signals.scope,
                "user_intent": self.routing_signals.user_intent,
                "operational_health": self.routing_signals.operational_health,
            },
        }


@dataclass(frozen=True)
class ExecutionPolicy:
    retrieval_depth: int
    tool_budget: int
    critique_passes: int
    planner_depth: int
    context_budget: int
    graph_variant: str
    response_depth: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "retrieval_depth": self.retrieval_depth,
            "tool_budget": self.tool_budget,
            "critique_passes": self.critique_passes,
            "planner_depth": self.planner_depth,
            "context_budget": self.context_budget,
            "graph_variant": self.graph_variant,
            "response_depth": self.response_depth,
        }


@dataclass(frozen=True)
class ModelResolution:
    preferred_provider: str
    preferred_model: str
    fallback_chain: list[str]
    local_fallback: str


_MODE_POLICY: dict[EffortMode, ExecutionPolicy] = {
    "auto": ExecutionPolicy(
        retrieval_depth=2,
        tool_budget=10,
        critique_passes=1,
        planner_depth=2,
        context_budget=120_000,
        graph_variant="shared",
        response_depth="balanced",
    ),
    "pulse": ExecutionPolicy(
        retrieval_depth=1,
        tool_budget=6,
        critique_passes=0,
        planner_depth=1,
        context_budget=80_000,
        graph_variant="shared",
        response_depth="concise",
    ),
    "core": ExecutionPolicy(
        retrieval_depth=2,
        tool_budget=10,
        critique_passes=1,
        planner_depth=2,
        context_budget=120_000,
        graph_variant="shared",
        response_depth="balanced",
    ),
    "horizon": ExecutionPolicy(
        retrieval_depth=3,
        tool_budget=14,
        critique_passes=2,
        planner_depth=3,
        context_budget=180_000,
        graph_variant="shared",
        response_depth="deep",
    ),
}


def policy_for_effort(mode: EffortMode) -> ExecutionPolicy:
    return _MODE_POLICY[mode]

