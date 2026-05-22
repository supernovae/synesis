"""Rollups for Yarn token-economics and cache-policy telemetry events."""

from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime
from typing import Any

TOKEN_ECONOMICS_EVENT_KINDS = (
    "request_trajectory_v1",
    "token_economics_warning_v1",
    "cache_policy_controller_decision_v1",
)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item.strip()]


def _bump(counter: Counter[str], key: Any) -> None:
    if isinstance(key, str) and key.strip():
        counter[key] += 1


def _counter_dict(counter: Counter[str]) -> dict[str, int]:
    return dict(counter.most_common())


def _event_iso(row: Any) -> str | None:
    created_at = getattr(row, "created_at", None)
    return created_at.isoformat() if hasattr(created_at, "isoformat") else None


def _event_sort_key(row: Any) -> datetime:
    created_at = getattr(row, "created_at", None)
    if isinstance(created_at, datetime):
        return created_at
    return datetime.fromtimestamp(0, tz=UTC)


def summarize_token_economics_events(
    rows: list[Any],
    *,
    since_hours: int,
    scope: str,
) -> dict[str, Any]:
    counts_by_event_kind: Counter[str] = Counter()
    cache_outcomes: Counter[str] = Counter()
    recommendations: Counter[str] = Counter()
    strategies: Counter[str] = Counter()
    token_warnings: Counter[str] = Counter()
    policy_actions: Counter[str] = Counter()
    policy_compaction_modes: Counter[str] = Counter()
    policy_reasons: Counter[str] = Counter()
    policy_providers: Counter[str] = Counter()
    policy_provider_strategies: Counter[str] = Counter()

    request_observation_count = 0
    warning_event_count = 0
    cache_hit_pct_total = 0.0
    cache_hit_pct_samples = 0
    premium_write_without_read_count = 0
    compaction_savings_unproven_count = 0
    telemetry_missing_count = 0
    policy_decision_count = 0
    cache_unavailable_count = 0
    retry_loop_risk_count = 0
    premium_write_suppressed_count = 0
    explicit_marker_disabled_count = 0
    latest_token_events: list[dict[str, Any]] = []
    latest_policy_events: list[dict[str, Any]] = []

    for row in sorted(rows, key=_event_sort_key, reverse=True):
        event_kind = str(getattr(row, "event_kind", "") or "")
        counts_by_event_kind[event_kind] += 1
        metadata = _as_dict(getattr(row, "metadata_json", None))

        token_economics: dict[str, Any] = {}
        if event_kind == "request_trajectory_v1":
            token_economics = _as_dict(_as_dict(metadata.get("cost")).get("token_economics"))
        elif event_kind == "token_economics_warning_v1":
            token_economics = metadata

        if token_economics:
            warnings = _as_strings(token_economics.get("warnings"))
            if event_kind == "request_trajectory_v1":
                request_observation_count += 1
                _bump(cache_outcomes, token_economics.get("cache_outcome"))
                _bump(recommendations, token_economics.get("recommendation"))
                _bump(strategies, token_economics.get("strategy"))
                cache_hit_pct = token_economics.get("cache_hit_pct")
                if isinstance(cache_hit_pct, (int, float)):
                    cache_hit_pct_total += float(cache_hit_pct)
                    cache_hit_pct_samples += 1
            elif event_kind == "token_economics_warning_v1":
                warning_event_count += 1

            for warning in warnings:
                token_warnings[warning] += 1
            if "premium_cache_write_without_read" in warnings:
                premium_write_without_read_count += 1
            if "compaction_savings_unproven_without_cache_hit" in warnings:
                compaction_savings_unproven_count += 1
            if "provider_usage_missing" in warnings:
                telemetry_missing_count += 1

            if len(latest_token_events) < 10:
                latest_token_events.append(
                    {
                        "created_at": _event_iso(row),
                        "event_kind": event_kind,
                        "session_key": getattr(row, "session_key", ""),
                        "request_id": getattr(row, "request_id", None),
                        "cache_outcome": token_economics.get("cache_outcome", ""),
                        "recommendation": token_economics.get("recommendation", ""),
                        "strategy": token_economics.get("strategy", ""),
                        "cache_hit_pct": token_economics.get("cache_hit_pct", 0),
                        "warnings": warnings,
                    }
                )

        if event_kind == "cache_policy_controller_decision_v1":
            policy_decision_count += 1
            _bump(policy_actions, metadata.get("action"))
            _bump(policy_compaction_modes, metadata.get("compaction_mode"))
            _bump(policy_providers, metadata.get("provider"))
            _bump(policy_provider_strategies, metadata.get("provider_cache_strategy"))
            reasons = _as_strings(metadata.get("reasons"))
            for reason in reasons:
                policy_reasons[reason] += 1
            if metadata.get("cache_unavailable") is True:
                cache_unavailable_count += 1
            if metadata.get("retry_loop_risk") is True:
                retry_loop_risk_count += 1
            if metadata.get("premium_cache_write_suppressed") is True:
                premium_write_suppressed_count += 1
            if metadata.get("allow_explicit_cache_markers") is False:
                explicit_marker_disabled_count += 1
            if len(latest_policy_events) < 10:
                latest_policy_events.append(
                    {
                        "created_at": _event_iso(row),
                        "session_key": getattr(row, "session_key", ""),
                        "request_id": getattr(row, "request_id", None),
                        "action": metadata.get("action", ""),
                        "compaction_mode": metadata.get("compaction_mode", ""),
                        "provider": metadata.get("provider", ""),
                        "provider_cache_strategy": metadata.get("provider_cache_strategy", ""),
                        "allow_explicit_cache_markers": metadata.get("allow_explicit_cache_markers", True),
                        "reasons": reasons,
                    }
                )

    avg_cache_hit_pct = round(cache_hit_pct_total / cache_hit_pct_samples, 2) if cache_hit_pct_samples > 0 else 0.0
    return {
        "since_hours": since_hours,
        "scope": scope,
        "inspected_events": len(rows),
        "counts_by_event_kind": _counter_dict(counts_by_event_kind),
        "token_economics": {
            "request_observation_count": request_observation_count,
            "warning_event_count": warning_event_count,
            "avg_cache_hit_pct": avg_cache_hit_pct,
            "cache_outcomes": _counter_dict(cache_outcomes),
            "recommendations": _counter_dict(recommendations),
            "strategies": _counter_dict(strategies),
            "warnings": _counter_dict(token_warnings),
            "premium_write_without_read_count": premium_write_without_read_count,
            "compaction_savings_unproven_count": compaction_savings_unproven_count,
            "telemetry_missing_count": telemetry_missing_count,
            "latest": latest_token_events,
        },
        "cache_policy": {
            "decision_count": policy_decision_count,
            "actions": _counter_dict(policy_actions),
            "compaction_modes": _counter_dict(policy_compaction_modes),
            "reasons": _counter_dict(policy_reasons),
            "providers": _counter_dict(policy_providers),
            "provider_strategies": _counter_dict(policy_provider_strategies),
            "cache_unavailable_count": cache_unavailable_count,
            "retry_loop_risk_count": retry_loop_risk_count,
            "premium_write_suppressed_count": premium_write_suppressed_count,
            "explicit_marker_disabled_count": explicit_marker_disabled_count,
            "latest": latest_policy_events,
        },
    }
