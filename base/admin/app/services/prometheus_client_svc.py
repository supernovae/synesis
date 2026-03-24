"""Parse Prometheus metrics from planner and LiteLLM endpoints."""

from __future__ import annotations

import logging
import os
import re
from typing import Any

import httpx

from ..deps import LITELLM_URL, PLANNER_URL

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


async def fetch_litellm_metrics() -> dict[str, Any]:
    url = f"{LITELLM_URL.rstrip('/')}/metrics"
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, timeout=5.0)
            resp.raise_for_status()
            return parse_prometheus_text(resp.text)
    except Exception as exc:
        logger.warning("litellm_metrics_error error=%s", str(exc)[:80])
        return {}


async def fetch_litellm_health() -> dict[str, Any]:
    """Fetch LiteLLM /health payload for per-model endpoint status."""
    url = f"{LITELLM_URL.rstrip('/')}/health"
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, timeout=5.0)
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, dict) else {}
    except Exception as exc:
        logger.warning("litellm_health_error error=%s", str(exc)[:80])
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
    return _build_retrieval_cache(raw)


async def get_extended_cache_metrics() -> dict[str, Any]:
    """Fetch Prometheus cache counters and planner /debug/cache-stats, merge into one response."""
    raw = await fetch_planner_metrics()
    cache_metrics = _build_retrieval_cache(raw)

    # Prompt cache from Prometheus
    pc_hits = _find_metric(raw, "synesis_prompt_cache_hits_total")
    pc_misses = _find_metric(raw, "synesis_prompt_cache_misses_total")
    pc_entries = _find_metric(raw, "synesis_prompt_cache_entries")
    pc_total = pc_hits + pc_misses
    cache_metrics["prompt_cache"] = {
        "hits": int(pc_hits),
        "misses": int(pc_misses),
        "entries": int(pc_entries),
        "hit_rate": pc_hits / pc_total if pc_total > 0 else 0,
    }

    # Frame cache from Prometheus
    fc_hits = _find_metric(raw, "synesis_frame_cache_hits_total")
    fc_misses = _find_metric(raw, "synesis_frame_cache_misses_total")
    fc_entries = _find_metric(raw, "synesis_frame_cache_entries")
    fc_total = fc_hits + fc_misses
    cache_metrics["frame_cache"] = {
        "hits": int(fc_hits),
        "misses": int(fc_misses),
        "entries": int(fc_entries),
        "hit_rate": fc_hits / fc_total if fc_total > 0 else 0,
    }

    # /debug/cache-stats for enrichment (TTL, max entries, etc.)
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

    # Enrich prompt cache with config from /debug/cache-stats
    pc_debug = extra.get("prompt_cache", {})
    if pc_debug:
        cache_metrics["prompt_cache"]["enabled"] = pc_debug.get("enabled", False)
        cache_metrics["prompt_cache"]["max_entries"] = pc_debug.get("max_entries", 0)
        cache_metrics["prompt_cache"]["ttl_seconds"] = pc_debug.get("ttl_seconds", 0)

    return cache_metrics


def _build_retrieval_cache(raw: dict[str, Any]) -> dict[str, Any]:
    """Build retrieval cache metrics from raw Prometheus data."""
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


_REMEDIATION_HINTS: dict[str, dict[str, str]] = {
    "llm": {
        "open": "Model is unreachable or timing out. Check model deployment health in OpenShift AI, verify vLLM pod status, and consider adding a fallback model in LiteLLM config.",
        "half_open": "Model recovering — probe requests being sent. If this persists, check model resource limits (GPU memory, max-model-len) in vLLM deployment.",
    },
    "web_search": {
        "open": "Web search provider is failing. Check API key validity, provider status page, and network egress rules.",
    },
    "infrastructure": {
        "open": "Service is down or unreachable. Check pod status, resource limits, and network policies in the cluster.",
        "half_open": "Service recovering. Monitor for repeated trips which may indicate resource pressure.",
    },
}


def _remediation(category: str, state: str) -> str | None:
    return _REMEDIATION_HINTS.get(category, {}).get(state)


async def get_circuit_breaker_metrics() -> list[dict[str, Any]]:
    raw = await fetch_planner_metrics()
    litellm_raw = await fetch_litellm_metrics()
    litellm_health = await fetch_litellm_health()
    breakers: list[dict[str, Any]] = []

    # 1. Infrastructure (health-monitor sidecar): synesis_circuit_breaker_state{service="..."}
    # State: 0=closed, 1=half_open, 2=open
    for key, entry in raw.items():
        if isinstance(entry, dict) and "synesis_circuit_breaker_state" in key and "synesis_llm_breaker" not in key:
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
                    "remediation": _remediation("infrastructure", state),
                }
            )

    # 2. LLM (gateway-owned): LiteLLM /health endpoint status + failure counters.
    # State mapping:
    # - unhealthy endpoint -> open
    # - no health signal + failures observed -> half_open (degraded/unknown)
    # - healthy endpoint (or no failures) -> closed
    failures_by_model = _collect_litellm_failures_by_model(litellm_raw)
    healthy_models = {
        str(ep.get("model", "unknown"))
        for ep in (litellm_health.get("healthy_endpoints") or [])
        if isinstance(ep, dict)
    }
    unhealthy_models = {
        str(ep.get("model", "unknown"))
        for ep in (litellm_health.get("unhealthy_endpoints") or [])
        if isinstance(ep, dict)
    }
    llm_models = sorted((healthy_models | unhealthy_models | set(failures_by_model.keys())) - {"unknown"})

    for name in llm_models:
        trips = int(failures_by_model.get(name, 0))
        if name in unhealthy_models:
            state = "open"
        elif name not in healthy_models and trips > 0:
            state = "half_open"
        else:
            state = "closed"
        breakers.append(
            {
                "name": name,
                "state": state,
                "trips": trips,
                "last_trip": None,
                "category": "llm",
                "remediation": _remediation("llm", state),
            }
        )

    # 3. Web search: synesis_web_search_breaker_state (unlabeled)
    # State: 0=closed, 1=open
    state_val = int(_get_unlabeled_metric(raw, "synesis_web_search_breaker_state"))
    trips = int(_get_unlabeled_metric(raw, "synesis_web_search_breaker_trips_total"))
    if any("synesis_web_search_breaker" in k for k in raw):
        state = "closed" if state_val == 0 else "open"
        breakers.append(
            {
                "name": "web_search",
                "state": state,
                "trips": trips,
                "last_trip": None,
                "category": "web_search",
                "remediation": _remediation("web_search", state),
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


def _collect_litellm_failures_by_model(raw: dict[str, Any]) -> dict[str, float]:
    """Aggregate litellm_deployment_failure_total by model-ish label."""
    failures: dict[str, float] = {}
    for key, entry in raw.items():
        if "litellm_deployment_failure_total" not in key or not isinstance(entry, dict):
            continue
        labels = entry.get("labels", {})
        model = (
            labels.get("model")
            or labels.get("model_group")
            or labels.get("deployment")
            or labels.get("litellm_model_name")
            or "unknown"
        )
        failures[model] = failures.get(model, 0.0) + float(entry.get("value", 0.0))
    return failures


_YARN_URL = os.getenv(
    "SYNESIS_YARN_URL",
    "http://synesis-yarn.synesis-yarn.svc.cluster.local:8000",
)


async def fetch_yarn_metrics() -> dict[str, Any]:
    url = f"{_YARN_URL.rstrip('/')}/metrics"
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, timeout=5.0)
            resp.raise_for_status()
            return parse_prometheus_text(resp.text)
    except Exception as exc:
        logger.warning("yarn_metrics_error error=%s", str(exc)[:80])
        return {}


async def get_yarn_live_metrics() -> dict[str, Any]:
    """Fetch live Prometheus counters from the Yarn /metrics endpoint."""
    raw = await fetch_yarn_metrics()
    if not raw:
        return {}
    return {
        "total_requests": int(_find_metric(raw, "yarn_requests_total")),
        "request_errors": int(_find_metric(raw, "yarn_request_errors_total")),
        "tokens_in": int(_find_metric(raw, "yarn_tokens_in_total")),
        "tokens_out": int(_find_metric(raw, "yarn_tokens_out_total")),
        "tokens_cached": int(_find_metric(raw, "yarn_tokens_cached_total")),
        "tool_calls": int(_find_metric(raw, "yarn_tool_calls_total")),
        "escalations": int(_find_metric(raw, "yarn_escalations_total")),
    }


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
