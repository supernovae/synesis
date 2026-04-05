from __future__ import annotations

import json
from typing import Any


def as_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, indent=2, sort_keys=True)


def kpi_as_markdown(payload: dict[str, Any]) -> str:
    intelligence = payload.get("intelligence", {})
    usage = payload.get("usage_summary", {})
    perf = payload.get("performance_summary", {})
    lines = [
        "# Synesis KPI Snapshot",
        "",
        f"- since_hours: {payload.get('since_hours')}",
        f"- requests: {intelligence.get('requests', 0)}",
        f"- completion_gate_blocked_rate: {intelligence.get('completion_gate_blocked_rate', 0)}",
        f"- critic_block_rate: {intelligence.get('critic_block_rate', 0)}",
        f"- first_pass_verify_rate: {intelligence.get('first_pass_verify_rate', 0)}",
        f"- structured_error_coverage: {intelligence.get('structured_error_coverage', 0)}",
        f"- usage_trace_count: {usage.get('trace_count', 0)}",
        f"- usage_estimated_cost_usd: {usage.get('estimated_cost_usd', 0)}",
        f"- performance_buckets: {perf.get('bucket_count', 0)}",
        f"- performance_error_rate: {perf.get('error_rate', 0)}",
    ]
    return "\n".join(lines) + "\n"


def session_as_markdown(payload: dict[str, Any]) -> str:
    s = payload.get("session", {})
    lines = [
        "# Synesis Session Inspect",
        "",
        f"- session_key: {s.get('session_key', '')}",
        f"- request_count: {s.get('request_count', 0)}",
        f"- trajectory_events: {payload.get('trajectory_events', 0)}",
        f"- completion_gate_blocked_events: {payload.get('completion_gate_blocked_events', 0)}",
        f"- critic_blocked_events: {payload.get('critic_blocked_events', 0)}",
        f"- first_pass_verify_ok_rate: {payload.get('first_pass_verify_ok_rate', 0)}",
        f"- avg_structured_error_coverage: {payload.get('avg_structured_error_coverage', 0)}",
    ]
    return "\n".join(lines) + "\n"


def generic_markdown(title: str, payload: dict[str, Any]) -> str:
    return f"# {title}\n\n```json\n{as_json(payload)}\n```\n"
