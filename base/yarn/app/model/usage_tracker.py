"""Per-request token and cost tracking with cached vs uncached breakdown."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("yarn.model.usage")


@dataclass
class UsageRecord:
    """Usage data for a single model invocation."""

    provider: str = ""
    model: str = ""
    tokens_in: int = 0
    tokens_out: int = 0
    tokens_cached: int = 0
    latency_ms: float = 0.0
    cost_usd: float = 0.0
    timestamp: float = field(default_factory=time.time)
    escalated: bool = False
    finish_reason: str = ""
    input_per_m: float = 0.0
    output_per_m: float = 0.0
    cached_per_m: float = 0.0

    @property
    def tokens_uncached(self) -> int:
        return max(0, self.tokens_in - self.tokens_cached)

    def compute_cost(self) -> float:
        """Compute cost using per-tier rates."""
        cached_cost = (self.tokens_cached / 1_000_000) * self.cached_per_m
        uncached_cost = (self.tokens_uncached / 1_000_000) * self.input_per_m
        output_cost = (self.tokens_out / 1_000_000) * self.output_per_m
        self.cost_usd = cached_cost + uncached_cost + output_cost
        return self.cost_usd

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "tokens_cached": self.tokens_cached,
            "tokens_uncached": self.tokens_uncached,
            "latency_ms": self.latency_ms,
            "cost_usd": self.cost_usd,
            "timestamp": self.timestamp,
            "escalated": self.escalated,
            "finish_reason": self.finish_reason,
        }


class UsageAggregator:
    """Aggregates usage across multiple invocations in a request."""

    def __init__(self) -> None:
        self.records: list[UsageRecord] = []

    def add(self, record: UsageRecord) -> None:
        record.compute_cost()
        self.records.append(record)

    @property
    def total_tokens_in(self) -> int:
        return sum(r.tokens_in for r in self.records)

    @property
    def total_tokens_out(self) -> int:
        return sum(r.tokens_out for r in self.records)

    @property
    def total_tokens_cached(self) -> int:
        return sum(r.tokens_cached for r in self.records)

    @property
    def total_cost_usd(self) -> float:
        return sum(r.cost_usd for r in self.records)

    @property
    def total_latency_ms(self) -> float:
        return sum(r.latency_ms for r in self.records)

    @property
    def cache_hit_rate(self) -> float:
        total_in = self.total_tokens_in
        if total_in == 0:
            return 0.0
        return self.total_tokens_cached / total_in
