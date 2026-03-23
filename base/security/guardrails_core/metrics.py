"""Prometheus metrics for guardrail detections and policy actions.

Both Planner and Yarn import this; counters/histograms are shared
across the process. Safe to import even when prometheus_client is
not installed (degrades to no-ops).
"""

from __future__ import annotations

try:
    from prometheus_client import Counter, Histogram

    GUARDRAIL_DETECTIONS = Counter(
        "synesis_guardrail_detections_total",
        "Total guardrail detections",
        ["service", "event_type", "severity", "action"],
    )

    GUARDRAIL_SCAN_LATENCY = Histogram(
        "synesis_guardrail_scan_latency_seconds",
        "Guardrail scan latency",
        ["service", "scanner"],
        buckets=(0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1),
    )

    GUARDRAIL_FALSE_POSITIVE_OVERRIDES = Counter(
        "synesis_guardrail_false_positive_overrides_total",
        "Operator-acknowledged false positives",
        ["service", "event_type"],
    )

    GUARDRAIL_TOKEN_FREEZES = Counter(
        "synesis_guardrail_token_freezes_total",
        "PAT/token freeze actions",
        ["service", "trigger"],
    )

    _HAS_PROMETHEUS = True

except ImportError:
    _HAS_PROMETHEUS = False


def record_detection(
    service: str,
    event_type: str,
    severity: str,
    action: str,
) -> None:
    if _HAS_PROMETHEUS:
        GUARDRAIL_DETECTIONS.labels(
            service=service, event_type=event_type,
            severity=severity, action=action,
        ).inc()


def record_scan_latency(service: str, scanner: str, seconds: float) -> None:
    if _HAS_PROMETHEUS:
        GUARDRAIL_SCAN_LATENCY.labels(service=service, scanner=scanner).observe(seconds)


def record_false_positive(service: str, event_type: str) -> None:
    if _HAS_PROMETHEUS:
        GUARDRAIL_FALSE_POSITIVE_OVERRIDES.labels(service=service, event_type=event_type).inc()


def record_token_freeze(service: str, trigger: str) -> None:
    if _HAS_PROMETHEUS:
        GUARDRAIL_TOKEN_FREEZES.labels(service=service, trigger=trigger).inc()
