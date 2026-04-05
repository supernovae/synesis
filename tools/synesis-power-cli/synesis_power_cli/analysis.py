from __future__ import annotations

from typing import Any


def build_kpi_snapshot(
    intelligence: dict[str, Any],
    performance: list[dict[str, Any]],
    usage_summary: dict[str, Any],
    since_hours: int,
    bucket_minutes: int,
) -> dict[str, Any]:
    total_requests = sum(int(row.get("requests", 0) or 0) for row in performance)
    total_errors = sum(int(row.get("errors", 0) or 0) for row in performance)
    max_latency = max((float(row.get("max_latency_ms", 0) or 0) for row in performance), default=0.0)
    avg_latency = (
        sum(float(row.get("avg_latency_ms", 0) or 0) for row in performance) / len(performance)
        if performance
        else 0.0
    )
    error_rate = (total_errors / total_requests) if total_requests else 0.0
    return {
        "since_hours": since_hours,
        "bucket_minutes": bucket_minutes,
        "intelligence": intelligence,
        "usage_summary": usage_summary,
        "performance_summary": {
            "bucket_count": len(performance),
            "total_requests": total_requests,
            "total_errors": total_errors,
            "error_rate": error_rate,
            "avg_latency_ms": avg_latency,
            "max_latency_ms": max_latency,
        },
        "raw": {
            "performance": performance,
        },
    }


def build_session_inspect(detail: dict[str, Any]) -> dict[str, Any]:
    events = detail.get("events", [])
    trajectory_events = [
        ev
        for ev in events
        if ev.get("event_kind") == "request_trajectory_v1" and isinstance(ev.get("metadata_json"), dict)
    ]
    completion_blocked = 0
    critic_blocked = 0
    first_pass_yes = 0
    parser_coverage_sum = 0.0
    parser_coverage_count = 0
    for ev in trajectory_events:
        metadata = ev.get("metadata_json") or {}
        verification = metadata.get("verification") if isinstance(metadata, dict) else None
        if not isinstance(verification, dict):
            continue
        if verification.get("completion_gate_blocked") is True:
            completion_blocked += 1
        if verification.get("critic_blocked") is True:
            critic_blocked += 1
        if verification.get("first_pass_verify_ok") is True:
            first_pass_yes += 1
        coverage = verification.get("structured_error_coverage")
        if isinstance(coverage, (int, float)):
            parser_coverage_sum += float(coverage)
            parser_coverage_count += 1

    trajectory_count = len(trajectory_events)
    return {
        "session": detail.get("session", {}),
        "trajectory_events": trajectory_count,
        "completion_gate_blocked_events": completion_blocked,
        "critic_blocked_events": critic_blocked,
        "first_pass_verify_ok_rate": (first_pass_yes / trajectory_count) if trajectory_count else 0.0,
        "avg_structured_error_coverage": (parser_coverage_sum / parser_coverage_count) if parser_coverage_count else 0.0,
        "event_kinds": sorted({str(ev.get("event_kind", "")) for ev in events}),
        "request_count": len(detail.get("requests", [])),
    }
