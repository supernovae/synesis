"""Prometheus metrics for the Yarn runtime."""

from __future__ import annotations

import logging

logger = logging.getLogger("yarn.telemetry.metrics")

_registered = False

request_counter = None
request_latency = None
token_counter = None
cache_hit_ratio = None
escalation_counter = None
tool_call_counter = None
active_sessions = None
circuit_breaker_state = None


def ensure_metrics() -> None:
    """Lazily register Prometheus metrics."""
    global _registered
    global request_counter, request_latency, token_counter, cache_hit_ratio
    global escalation_counter, tool_call_counter, active_sessions, circuit_breaker_state

    if _registered:
        return

    try:
        from prometheus_client import Counter, Gauge, Histogram

        request_counter = Counter(
            "yarn_requests_total",
            "Total chat completion requests",
            ["status", "provider"],
        )
        request_latency = Histogram(
            "yarn_request_latency_seconds",
            "Request latency in seconds",
            ["provider"],
            buckets=[0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0],
        )
        token_counter = Counter(
            "yarn_tokens_total",
            "Token usage",
            ["direction", "cache_status", "provider"],
        )
        cache_hit_ratio = Gauge(
            "yarn_cache_hit_ratio",
            "Rolling cache hit ratio",
            ["provider"],
        )
        escalation_counter = Counter(
            "yarn_escalations_total",
            "Requests escalated to planner",
            ["reason"],
        )
        tool_call_counter = Counter(
            "yarn_tool_calls_total",
            "Tool calls executed",
            ["tool_name", "status"],
        )
        active_sessions = Gauge(
            "yarn_active_sessions",
            "Currently active sessions",
        )
        circuit_breaker_state = Gauge(
            "yarn_circuit_breaker_state",
            "Circuit breaker state (0=closed, 1=open, 2=half_open)",
            ["provider"],
        )
    except Exception:
        logger.warning("Failed to register Prometheus metrics")

    _registered = True


def record_request(status: str, provider: str, latency_s: float) -> None:
    ensure_metrics()
    if request_counter:
        request_counter.labels(status=status, provider=provider).inc()
    if request_latency:
        request_latency.labels(provider=provider).observe(latency_s)


def record_tokens(
    tokens_in: int,
    tokens_out: int,
    tokens_cached: int,
    provider: str,
) -> None:
    ensure_metrics()
    if token_counter:
        token_counter.labels(direction="in", cache_status="uncached", provider=provider).inc(
            max(0, tokens_in - tokens_cached)
        )
        token_counter.labels(direction="in", cache_status="cached", provider=provider).inc(tokens_cached)
        token_counter.labels(direction="out", cache_status="n/a", provider=provider).inc(tokens_out)


def record_escalation(reason: str) -> None:
    ensure_metrics()
    if escalation_counter:
        escalation_counter.labels(reason=reason).inc()


def record_tool_call(tool_name: str, success: bool) -> None:
    ensure_metrics()
    if tool_call_counter:
        tool_call_counter.labels(tool_name=tool_name, status="success" if success else "error").inc()
