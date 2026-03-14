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
        match = re.match(r'^(\w+)(\{[^}]*\})?\s+([\d.eE+-]+|NaN|Inf|-Inf)$', line)
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


async def get_circuit_breaker_metrics() -> list[dict[str, Any]]:
    raw = await fetch_planner_metrics()
    breakers = []
    for key, entry in raw.items():
        if isinstance(entry, dict) and "synesis_circuit_breaker_state" in key:
            labels = entry.get("labels", {})
            name = labels.get("service", labels.get("role", key))
            state_val = entry.get("value", 0)
            state = "closed" if state_val == 0 else ("open" if state_val == 1 else "half_open")
            breakers.append({"name": name, "state": state, "trips": 0, "last_trip": None})
    return breakers


async def get_pipeline_node_metrics() -> list[dict[str, Any]]:
    raw = await fetch_planner_metrics()
    nodes = []
    for key, entry in raw.items():
        if isinstance(entry, dict) and "synesis_node_confidence" in key:
            labels = entry.get("labels", {})
            node_name = labels.get("node", "unknown")
            nodes.append({
                "node": node_name,
                "avg_confidence": entry.get("value", 0),
                "avg_duration_ms": 0,
                "call_count": 0,
            })
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
