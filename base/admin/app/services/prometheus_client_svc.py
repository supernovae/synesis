"""Parse Prometheus text metrics from planner /metrics endpoint."""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from ..deps import PLANNER_URL

logger = logging.getLogger("synesis.admin.prometheus")


async def fetch_planner_metrics() -> dict[str, Any]:
    url = f"{PLANNER_URL.rstrip('/')}/metrics"
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, timeout=5.0)
            resp.raise_for_status()
            return parse_prometheus_text(resp.text)
    except Exception as exc:
        logger.warning("planner_metrics_error error=%s", str(exc)[:80])
        return {}


def parse_prometheus_text(text: str) -> dict[str, Any]:
    """Parse Prometheus exposition format into {metric_name: value_or_dict}."""
    metrics: dict[str, Any] = {}
    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        match = re.match(r"^(\w+)(\{[^}]*\})?\s+([\d.eE+-]+|NaN|Inf|-Inf)$", line)
        if not match:
            continue
        name, labels_str, val_str = match.groups()
        try:
            value = float(val_str)
        except ValueError:
            continue
        if labels_str:
            labels = dict(re.findall(r'(\w+)="([^"]*)"', labels_str))
            key = f"{name}_{labels}" if labels else name
            metrics[key] = {"value": value, "labels": labels}
        else:
            metrics[name] = value
    return metrics


async def get_cache_metrics() -> dict[str, Any]:
    raw = await fetch_planner_metrics()
    exact = _find_metric(raw, "synesis_cache_exact_hits_total")
    semantic = _find_metric(raw, "synesis_cache_semantic_hits_total")
    misses = _find_metric(raw, "synesis_cache_misses_total")
    evictions = _find_metric(raw, "synesis_cache_evictions_total")
    entries = _find_metric(raw, "synesis_cache_entries")
    total_hits = exact + semantic
    total = total_hits + misses
    return {
        "exact_hits": exact,
        "semantic_hits": semantic,
        "misses": misses,
        "evictions": evictions,
        "entries": entries,
        "hit_rate": total_hits / total if total > 0 else 0,
    }


async def get_extended_cache_metrics() -> dict[str, Any]:
    """Fetch Prometheus cache counters and planner /debug/cache-stats, merge into one response."""
    cache_metrics = await get_cache_metrics()
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{PLANNER_URL.rstrip('/')}/debug/cache-stats",
                timeout=5.0,
            )
            resp.raise_for_status()
            extra = resp.json()
    except Exception as exc:
        logger.warning("planner_cache_stats_error error=%s", str(exc)[:80])
        return cache_metrics

    cache_metrics["redis"] = extra.get("redis", {})
    cache_metrics["session"] = extra.get("session", {})
    cache_metrics["l2_archive"] = extra.get("l2_archive", {})
    return cache_metrics


def _get_labeled_trips(raw: dict, prefix: str, label_key: str, label_val: str) -> int:
    """Get trip count for a metric with the given label."""
    for key, entry in raw.items():
        if prefix not in key or not isinstance(entry, dict):
            continue
        labels = entry.get("labels", {})
        if labels.get(label_key) == label_val:
            return int(entry.get("value", 0))
    return 0


def _get_unlabeled_metric(raw: dict, name: str) -> float:
    """Get value for an unlabeled metric."""
    if name in raw and isinstance(raw[name], (int, float)):
        return float(raw[name])
    for key, entry in raw.items():
        if name in key:
            if isinstance(entry, (int, float)):
                return float(entry)
            if isinstance(entry, dict):
                return float(entry.get("value", 0))
    return 0.0


async def get_circuit_breaker_metrics() -> list[dict[str, Any]]:
    raw = await fetch_planner_metrics()
    breakers: list[dict[str, Any]] = []

    # 1. Infrastructure (health-monitor sidecar): synesis_circuit_breaker_state{service="..."}
    # State: 0=closed, 1=half_open, 2=open
    for key, entry in raw.items():
        if (
            isinstance(entry, dict)
            and "synesis_circuit_breaker_state" in key
            and "synesis_llm_breaker" not in key
        ):
            labels = entry.get("labels", {})
            if "service" not in labels:
                continue
            name = labels["service"]
            state_val = int(entry.get("value", 0))
            state = "closed" if state_val == 0 else ("half_open" if state_val == 1 else "open")
            trips = _get_labeled_trips(raw, "synesis_circuit_breaker_trips_total", "service", name)
            breakers.append(
                {
                    "name": name,
                    "state": state,
                    "trips": trips,
                    "last_trip": None,
                    "category": "infrastructure",
                }
            )

    # 2. LLM: synesis_llm_breaker_state{role="..."}
    # State: 0=closed, 1=open, 2=half_open
    for key, entry in raw.items():
        if isinstance(entry, dict) and "synesis_llm_breaker_state" in key:
            labels = entry.get("labels", {})
            if "role" not in labels:
                continue
            name = labels["role"]
            state_val = int(entry.get("value", 0))
            state = "closed" if state_val == 0 else ("half_open" if state_val == 2 else "open")
            trips = _get_labeled_trips(raw, "synesis_circuit_breaker_open_total", "role", name)
            breakers.append(
                {
                    "name": name,
                    "state": state,
                    "trips": trips,
                    "last_trip": None,
                    "category": "llm",
                }
            )

    # 3. Web search: synesis_web_search_breaker_state (unlabeled)
    # State: 0=closed, 1=open
    state_val = int(_get_unlabeled_metric(raw, "synesis_web_search_breaker_state"))
    trips = int(_get_unlabeled_metric(raw, "synesis_web_search_breaker_trips_total"))
    if any("synesis_web_search_breaker" in k for k in raw.keys()):
        state = "closed" if state_val == 0 else "open"
        breakers.append(
            {
                "name": "web_search",
                "state": state,
                "trips": trips,
                "last_trip": None,
                "category": "web_search",
            }
        )

    return breakers


async def get_pipeline_node_metrics() -> list[dict[str, Any]]:
    raw = await fetch_planner_metrics()
    nodes = []
    for key, entry in raw.items():
        if isinstance(entry, dict) and "synesis_node_confidence" in key:
            labels = entry.get("labels", {})
            node_name = labels.get("node", "unknown")
            nodes.append(
                {
                    "node": node_name,
                    "avg_confidence": entry.get("value", 0),
                    "avg_duration_ms": 0,
                    "call_count": 0,
                }
            )
    return nodes


async def get_critic_stats() -> dict[str, Any]:
    raw = await fetch_planner_metrics()
    approved = _find_metric(raw, "synesis_background_critic_approved_total")
    rejected = _find_metric(raw, "synesis_background_critic_rejected_total")
    rejections = _find_metric(raw, "synesis_critic_rejections_total")
    total = approved + rejected
    return {
        "total_evaluations": total,
        "approval_rate": approved / total if total > 0 else 0,
        "rejection_rate": rejected / total if total > 0 else 0,
        "avg_score": 0,
        "blocking_issues": int(rejections),
    }


async def get_model_performance() -> list[dict[str, Any]]:
    raw = await fetch_planner_metrics()
    models: dict[str, dict] = {}
    for key, entry in raw.items():
        if isinstance(entry, dict) and "synesis_tokens_total" in key:
            labels = entry.get("labels", {})
            model = labels.get("model", "unknown")
            if model not in models:
                models[model] = {"model": model, "tokens": 0, "requests": 0}
            models[model]["tokens"] += entry.get("value", 0)
    return list(models.values())


def _find_metric(raw: dict, prefix: str) -> float:
    if prefix in raw and isinstance(raw[prefix], (int, float)):
        return float(raw[prefix])
    for key, entry in raw.items():
        if prefix in key:
            if isinstance(entry, (int, float)):
                return float(entry)
            if isinstance(entry, dict):
                return float(entry.get("value", 0))
    return 0.0


def _sum_labeled_metric(
    raw: dict,
    prefix: str,
    label_filter: dict[str, str] | None = None,
) -> float:
    """Sum all entries matching a metric name prefix, optionally filtered by labels."""
    total = 0.0
    for key, entry in raw.items():
        if prefix not in key:
            continue
        if isinstance(entry, (int, float)):
            if label_filter is None:
                total += float(entry)
        elif isinstance(entry, dict):
            labels = entry.get("labels", {})
            if label_filter is None or all(labels.get(k) == v for k, v in label_filter.items()):
                total += float(entry.get("value", 0))
    return total


async def get_web_search_stats() -> dict[str, Any]:
    """Compute web search stats from Prometheus labeled counters and histograms."""
    raw = await fetch_planner_metrics()
    total = _sum_labeled_metric(raw, "synesis_web_search_total")
    errors = _sum_labeled_metric(raw, "synesis_web_search_total", {"outcome": "error"})
    error_rate = errors / total if total > 0 else 0.0

    duration_sum = _sum_labeled_metric(raw, "synesis_web_search_duration_seconds_sum")
    duration_count = _sum_labeled_metric(raw, "synesis_web_search_duration_seconds_count")
    avg_latency_ms = (duration_sum / duration_count * 1000) if duration_count > 0 else None

    return {
        "total": int(total),
        "avg_latency_ms": round(avg_latency_ms, 1) if avg_latency_ms is not None else None,
        "error_rate": round(error_rate, 4) if total > 0 else None,
    }
