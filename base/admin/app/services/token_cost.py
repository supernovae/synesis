"""Token cost estimation with optional cached prompt pricing."""

from __future__ import annotations

import os
from collections.abc import Mapping


def _default_cached_multiplier() -> float:
    return float(os.environ.get("SYNESIS_CACHED_INPUT_PRICE_MULTIPLIER", "0.1"))


def effective_cached_input_rate(input_per_million: float, input_cached_per_million: float | None) -> float:
    """USD per million cached prompt tokens; falls back to input rate × multiplier when unset."""
    if input_cached_per_million is not None and input_cached_per_million >= 0:
        return input_cached_per_million
    return max(0.0, float(input_per_million)) * _default_cached_multiplier()


def estimate_llm_call_cost_usd(
    prompt_tokens: int,
    completion_tokens: int,
    cached_prompt_tokens: int,
    *,
    input_per_million: float,
    output_per_million: float,
    input_cached_per_million: float | None = None,
) -> float:
    pt = max(0, int(prompt_tokens or 0))
    cached = min(max(0, int(cached_prompt_tokens or 0)), pt)
    uncached = pt - cached
    ct = max(0, int(completion_tokens or 0))
    ic_rate = effective_cached_input_rate(input_per_million, input_cached_per_million)
    return round(
        (uncached / 1_000_000) * float(input_per_million)
        + (cached / 1_000_000) * ic_rate
        + (ct / 1_000_000) * float(output_per_million),
        6,
    )


def parse_recorded_estimated_cost(call: Mapping[str, object]) -> float | None:
    """Return estimated cost from trace call payload when present and valid."""
    raw = call.get("estimated_cost")
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value < 0:
        return None
    return value


def estimate_llm_call_cost_from_payload(
    call: Mapping[str, object],
    *,
    input_per_million: float,
    output_per_million: float,
    input_cached_per_million: float | None = None,
) -> float:
    """Estimate call cost from trace call payload token fields."""
    return estimate_llm_call_cost_usd(
        int(call.get("prompt_tokens", 0) or 0),
        int(call.get("completion_tokens", 0) or 0),
        int(call.get("cached_prompt_tokens", 0) or 0),
        input_per_million=input_per_million,
        output_per_million=output_per_million,
        input_cached_per_million=input_cached_per_million,
    )
