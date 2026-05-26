"""Yarn cache-shape and pipeline optimization summaries for operators."""

from __future__ import annotations

import json
from collections import Counter
from datetime import UTC, datetime
from math import ceil
from statistics import mean
from typing import Any

HASH_FIELDS = {
    "stable_prefix": ("cacheShapeStablePrefixHash", "cacheShapeStablePrefixBytes"),
    "tool_schema": ("cacheShapeToolSchemaHash", "cacheShapeToolSchemaBytes"),
    "provider_options": ("cacheShapeProviderOptionsHash", "cacheShapeProviderOptionsBytes"),
    "normalized_transcript_prefix": (
        "cacheShapeNormalizedTranscriptPrefixHash",
        "cacheShapeNormalizedTranscriptPrefixBytes",
    ),
    "cache_policy": ("cacheShapeCachePolicyHash", "cacheShapeCachePolicyBytes"),
    "model_provider_resolution": (
        "cacheShapeModelProviderResolutionHash",
        "cacheShapeModelProviderResolutionBytes",
    ),
}

STAGE_WARN_P95_MS = {
    "ingress": 500.0,
    "normalization": 1500.0,
    "pruning": 1500.0,
    "enrichment": 2500.0,
    "governor": 1500.0,
    "provider_options": 1000.0,
    "provider": 20_000.0,
    "provider_call": 20_000.0,
    "stream": 45_000.0,
    "persistence": 2500.0,
}


def _records(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict):
        value = value.get("diagnostics", [])
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _nonnegative_number(value: Any) -> float:
    parsed = _number(value)
    return max(0.0, parsed) if parsed is not None else 0.0


def _string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _percent_from_tokens(cached_tokens: float, prompt_tokens: float) -> float | None:
    if prompt_tokens <= 0:
        return None
    return round((cached_tokens / prompt_tokens) * 100, 2)


def _p95(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, ceil(len(ordered) * 0.95) - 1))
    return round(ordered[idx], 2)


def _avg(values: list[float]) -> float:
    return round(mean(values), 2) if values else 0.0


def _status_for_findings(findings: list[dict[str, Any]], sample_count: int) -> str:
    if sample_count == 0:
        return "unknown"
    severities = {str(f.get("severity", "")) for f in findings}
    if "critical" in severities:
        return "critical"
    if "warning" in severities:
        return "warn"
    return "healthy"


def _finding(
    severity: str,
    code: str,
    title: str,
    detail: str,
    *,
    evidence: dict[str, Any] | None = None,
    recommended_action: str,
) -> dict[str, Any]:
    return {
        "severity": severity,
        "code": code,
        "title": title,
        "detail": detail,
        "evidence": evidence or {},
        "recommended_action": recommended_action,
    }


def _stage_summary(records: list[dict[str, Any]]) -> dict[str, dict[str, float | int]]:
    grouped: dict[str, list[float]] = {}
    for record in records:
        stages = record.get("stageTimingsMs")
        if not isinstance(stages, dict):
            continue
        for stage, raw_value in stages.items():
            if not isinstance(stage, str):
                continue
            value = _number(raw_value)
            if value is None:
                continue
            grouped.setdefault(stage, []).append(max(0.0, value))

    return {
        stage: {
            "samples": len(values),
            "avg_ms": _avg(values),
            "p95_ms": _p95(values),
            "max_ms": round(max(values), 2),
        }
        for stage, values in sorted(grouped.items())
    }


def _hash_stability(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    stability: dict[str, dict[str, Any]] = {}
    for name, (hash_field, bytes_field) in HASH_FIELDS.items():
        hashes = [_string(record.get(hash_field)) for record in records]
        hashes = [value for value in hashes if value]
        byte_values = [
            _nonnegative_number(record.get(bytes_field)) for record in records if record.get(bytes_field) is not None
        ]
        latest_hash = hashes[-1] if hashes else ""
        stability[name] = {
            "observed": len(hashes),
            "unique": len(set(hashes)),
            "latest_hash": latest_hash,
            "avg_bytes": _avg(byte_values),
            "latest_bytes": byte_values[-1] if byte_values else 0,
            "stability_ratio": round((len(set(hashes)) / len(hashes)), 3) if hashes else 0.0,
        }
    return stability


def build_yarn_optimization_health(payload: Any) -> dict[str, Any]:
    """Build a compact operator summary from Yarn recent diagnostics."""
    records = _records(payload)
    sample_count = len(records)
    source = payload.get("source") if isinstance(payload, dict) else None
    outcomes = Counter(_string(record.get("cacheShapeOutcome")) or "unknown" for record in records)
    prompt_tokens = sum(_nonnegative_number(record.get("cacheShapePromptTokens")) for record in records)
    cached_tokens = sum(_nonnegative_number(record.get("cacheShapeCachedTokens")) for record in records)
    cache_creation_tokens = sum(_nonnegative_number(record.get("cacheShapeCacheCreationTokens")) for record in records)
    hit_values = [value for record in records if (value := _number(record.get("cacheShapeHitPct"))) is not None]
    latest = records[-1] if records else {}
    latest_prompt = _nonnegative_number(latest.get("cacheShapePromptTokens"))
    latest_cached = _nonnegative_number(latest.get("cacheShapeCachedTokens"))
    derived_cache_hit_pct = _percent_from_tokens(cached_tokens, prompt_tokens)
    latest_cache_hit_pct = _number(latest.get("cacheShapeHitPct"))
    if latest_cache_hit_pct is None:
        latest_cache_hit_pct = _percent_from_tokens(latest_cached, latest_prompt) or 0.0

    stage_timings = _stage_summary(records)
    stability = _hash_stability(records)
    findings: list[dict[str, Any]] = []

    if sample_count == 0:
        findings.append(
            _finding(
                "warning",
                "no_diagnostics",
                "No recent request diagnostics",
                "Yarn did not return recent request diagnostics, so cache and stage health cannot be inferred.",
                recommended_action="Verify the Yarn diagnostics ring is enabled and that the admin API can reach /v1/diagnostics/recent.",
            )
        )
    elif prompt_tokens > 0:
        aggregate_hit = derived_cache_hit_pct or 0.0
        if aggregate_hit < 20.0 and sample_count >= 3:
            findings.append(
                _finding(
                    "warning",
                    "low_cache_reuse",
                    "Low aggregate cache reuse",
                    "Recent requests report low cached-token reuse relative to prompt tokens.",
                    evidence={
                        "cache_hit_pct": aggregate_hit,
                        "prompt_tokens": int(prompt_tokens),
                        "cached_tokens": int(cached_tokens),
                        "samples": sample_count,
                    },
                    recommended_action="Compare stable prefix, tool schema, provider options, and cache policy hashes for churn before changing prompts.",
                )
            )
        if outcomes["unknown"] / sample_count >= 0.5:
            findings.append(
                _finding(
                    "info",
                    "provider_cache_not_reported",
                    "Provider cache accounting is incomplete",
                    "Most diagnostics did not include a provider-visible cache outcome.",
                    evidence={"unknown_outcomes": outcomes["unknown"], "samples": sample_count},
                    recommended_action="Confirm whether this provider reports cached tokens; fall back to prefix/hash stability when it does not.",
                )
            )

    for key in ("tool_schema", "provider_options", "cache_policy", "model_provider_resolution"):
        row = stability[key]
        observed = int(row["observed"])
        unique = int(row["unique"])
        if observed >= 5 and unique >= 3 and unique / observed >= 0.35:
            findings.append(
                _finding(
                    "warning",
                    f"unstable_{key}",
                    f"Unstable {key.replace('_', ' ')} hash",
                    "A cache-critical request component is changing often across recent diagnostics.",
                    evidence={"observed": observed, "unique": unique, "stability_ratio": row["stability_ratio"]},
                    recommended_action="Inspect route normalization and request construction for nondeterministic ordering or per-request metadata in this component.",
                )
            )

    stable_prefix = stability["stable_prefix"]
    if int(stable_prefix["observed"]) >= 3 and float(stable_prefix["avg_bytes"]) < 2048:
        findings.append(
            _finding(
                "info",
                "small_stable_prefix",
                "Stable prefix is small",
                "The stable prefix is likely too short to give provider prompt caching much room to work.",
                evidence={"avg_bytes": stable_prefix["avg_bytes"], "observed": stable_prefix["observed"]},
                recommended_action="Keep system/developer/tool schema content before request-specific transcript content where protocol permits.",
            )
        )

    for stage, summary in stage_timings.items():
        threshold = STAGE_WARN_P95_MS.get(stage, STAGE_WARN_P95_MS.get(stage.replace("_ms", ""), 0.0))
        if threshold > 0 and float(summary["p95_ms"]) > threshold:
            findings.append(
                _finding(
                    "warning",
                    f"slow_stage_{stage}",
                    f"Slow {stage.replace('_', ' ')} stage",
                    "A pipeline stage is above its warning p95 threshold.",
                    evidence={"stage": stage, "p95_ms": summary["p95_ms"], "threshold_ms": threshold},
                    recommended_action="Open recent request diagnostics for this stage and compare whether slow paths correlate with cache misses or large tool outputs.",
                )
            )

    if not findings and sample_count > 0:
        findings.append(
            _finding(
                "info",
                "no_major_alerts",
                "No major cache-shape alerts",
                "Recent diagnostics do not show obvious cache-critical churn or slow stage timing.",
                recommended_action="Keep monitoring after route or prompt changes; compare stable hash counts before and after each release.",
            )
        )

    status = _status_for_findings(findings, sample_count)
    summary = {
        "sample_count": sample_count,
        "source": source or "unknown",
        "cache_hit_avg_pct": _avg(hit_values) if hit_values else (derived_cache_hit_pct or 0.0),
        "cache_hit_token_pct": derived_cache_hit_pct or 0.0,
        "latest_cache_hit_pct": round(latest_cache_hit_pct or 0.0, 2),
        "prompt_tokens": int(prompt_tokens),
        "cached_tokens": int(cached_tokens),
        "cache_creation_tokens": int(cache_creation_tokens),
        "outcome_counts": dict(outcomes),
    }
    next_actions = [str(f["recommended_action"]) for f in findings[:4]]

    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "status": status,
        "summary": summary,
        "stability": stability,
        "stage_timings": stage_timings,
        "latest": {
            "request_id": latest.get("requestId"),
            "path": latest.get("path"),
            "session_key": latest.get("sessionKey"),
            "cache_shape_outcome": latest.get("cacheShapeOutcome"),
            "cache_hit_pct": round(latest_cache_hit_pct or 0.0, 2),
            "latency_ms": latest.get("latencyMs"),
            "finish_reason": latest.get("finishReason"),
            "decision_path": latest.get("decisionPath"),
        },
        "findings": findings,
        "next_actions": next_actions,
    }


def build_yarn_optimization_watcher(payload: Any) -> dict[str, Any]:
    """Return an AI-ready watcher report from recent Yarn diagnostics."""
    health = build_yarn_optimization_health(payload)
    findings = health["findings"]
    top_finding = findings[0] if findings else None
    status = str(health["status"])
    sample_count = int(health["summary"]["sample_count"])
    if status == "unknown":
        summary = "No recent Yarn diagnostics are available for cache or pipeline analysis."
    elif status == "healthy":
        summary = f"Yarn cache/pipeline diagnostics look stable across {sample_count} recent samples."
    elif top_finding:
        summary = f"Yarn optimization watcher is {status}: {top_finding['title']}."
    else:
        summary = f"Yarn optimization watcher is {status}."

    return {
        **health,
        "watcher_report": {
            "status": status,
            "summary": summary,
            "findings": findings,
            "next_actions": health["next_actions"],
            "model_assist_ready": True,
            "model_assist_prompt": (
                "Summarize these Yarn cache-shape and stage-timing findings for an operator. "
                "Focus on likely causes, evidence, and the safest next diagnostic action."
            ),
        },
    }


def build_yarn_optimization_ai_messages(
    watcher: dict[str, Any],
    *,
    focus: str = "",
) -> list[dict[str, str]]:
    """Build a privacy-trimmed prompt for model-assisted watcher analysis."""
    latest = watcher.get("latest") if isinstance(watcher.get("latest"), dict) else {}
    sanitized = {
        "status": watcher.get("status"),
        "summary": watcher.get("summary"),
        "stability": watcher.get("stability"),
        "stage_timings": watcher.get("stage_timings"),
        "latest": {
            "request_id": latest.get("request_id"),
            "path": latest.get("path"),
            "cache_shape_outcome": latest.get("cache_shape_outcome"),
            "cache_hit_pct": latest.get("cache_hit_pct"),
            "latency_ms": latest.get("latency_ms"),
            "finish_reason": latest.get("finish_reason"),
            "decision_path": latest.get("decision_path"),
        },
        "findings": watcher.get("findings"),
        "next_actions": watcher.get("next_actions"),
    }
    focus_text = focus.strip()
    if focus_text:
        sanitized["operator_focus"] = focus_text

    return [
        {
            "role": "system",
            "content": (
                "You are the Synesis optimization watcher. Analyze only the supplied "
                "Yarn cache-shape and pipeline timing telemetry. Do not invent missing "
                "data. Be concise, evidence-based, and practical. Prioritize likely "
                "causes of cache misses, unstable prompt prefixes, tool schema churn, "
                "provider option churn, and slow pipeline stages. Return Markdown with "
                "sections: Status, Evidence, Likely Causes, Next Actions, Caveats."
            ),
        },
        {
            "role": "user",
            "content": "Yarn optimization watcher telemetry:\n" + json.dumps(sanitized, sort_keys=True, default=str),
        },
    ]
