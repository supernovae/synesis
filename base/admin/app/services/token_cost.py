"""Token cost estimation with optional cached prompt pricing."""

from __future__ import annotations

import os


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
