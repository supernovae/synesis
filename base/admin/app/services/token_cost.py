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
    cache_creation_tokens: int = 0,
    *,
    input_per_million: float,
    output_per_million: float,
    input_cached_per_million: float | None = None,
    input_cache_write_per_million: float | None = None,
) -> float:
    pt = max(0, int(prompt_tokens or 0))
    cached = min(max(0, int(cached_prompt_tokens or 0)), pt)
    uncached = pt - cached
    ct = max(0, int(completion_tokens or 0))
    cc = max(0, int(cache_creation_tokens or 0))
    ic_rate = effective_cached_input_rate(input_per_million, input_cached_per_million)
    cw_rate = (
        float(input_cache_write_per_million)
        if input_cache_write_per_million is not None and input_cache_write_per_million >= 0
        else float(input_per_million)
    )
    return round(
        (uncached / 1_000_000) * float(input_per_million)
        + (cached / 1_000_000) * ic_rate
        + (ct / 1_000_000) * float(output_per_million)
        + (cc / 1_000_000) * cw_rate,
        6,
    )


def estimate_llm_cost_breakdown(
    prompt_tokens: int,
    completion_tokens: int,
    cached_prompt_tokens: int,
    cache_creation_tokens: int = 0,
    *,
    input_per_million: float,
    output_per_million: float,
    input_cached_per_million: float | None = None,
    input_cache_write_per_million: float | None = None,
) -> dict[str, float | int]:
    """Return a transparent per-component estimate for cache-aware billing."""
    pt = max(0, int(prompt_tokens or 0))
    cached = min(max(0, int(cached_prompt_tokens or 0)), pt)
    uncached = pt - cached
    ct = max(0, int(completion_tokens or 0))
    cw = max(0, int(cache_creation_tokens or 0))
    input_rate = float(input_per_million)
    output_rate = float(output_per_million)
    cached_rate = effective_cached_input_rate(input_rate, input_cached_per_million)
    write_rate = (
        float(input_cache_write_per_million)
        if input_cache_write_per_million is not None and input_cache_write_per_million >= 0
        else input_rate
    )
    input_cost = (uncached / 1_000_000) * input_rate
    cache_read_cost = (cached / 1_000_000) * cached_rate
    cache_write_cost = (cw / 1_000_000) * write_rate
    output_cost = (ct / 1_000_000) * output_rate
    estimated = input_cost + cache_read_cost + cache_write_cost + output_cost
    no_cache = (pt / 1_000_000) * input_rate + (ct / 1_000_000) * output_rate
    return {
        "tokens_uncached_input": uncached,
        "tokens_cache_read": cached,
        "tokens_cache_write": cw,
        "tokens_output": ct,
        "input_cost_usd": round(input_cost, 8),
        "cache_read_cost_usd": round(cache_read_cost, 8),
        "cache_write_cost_usd": round(cache_write_cost, 8),
        "output_cost_usd": round(output_cost, 8),
        "estimated_cost_usd": round(estimated, 8),
        "estimated_no_cache_cost_usd": round(no_cache, 8),
        "cache_savings_usd": round(no_cache - estimated, 8),
    }


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
    input_cache_write_per_million: float | None = None,
) -> float:
    """Estimate call cost from trace call payload token fields."""
    return estimate_llm_call_cost_usd(
        int(call.get("prompt_tokens", 0) or 0),
        int(call.get("completion_tokens", 0) or 0),
        int(call.get("cached_prompt_tokens", 0) or 0),
        int(call.get("cache_creation_tokens", 0) or 0),
        input_per_million=input_per_million,
        output_per_million=output_per_million,
        input_cached_per_million=input_cached_per_million,
        input_cache_write_per_million=input_cache_write_per_million,
    )
