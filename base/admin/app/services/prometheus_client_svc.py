"""Parse Prometheus metrics from planner and LiteLLM endpoints."""

from __future__ import annotations

import logging
import os
import re
from typing import Any

import httpx

from ..deps import LITELLM_URL, PLANNER_TS_URL, PLANNER_URL, YARN_TS_URL

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
    """Fetch prefix cache metrics from planner-ts and yarn-ts."""
    return await get_extended_cache_metrics()


async def _fetch_service_metrics(url: str) -> dict[str, Any]:
    """Scrape a service's /metrics endpoint."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{url.rstrip('/')}/metrics", timeout=3.0)
            resp.raise_for_status()
            return parse_prometheus_text(resp.text)
    except Exception:
        return {}


async def _fetch_service_health(url: str, path: str = "/health") -> dict[str, Any]:
    """Scrape a service's health endpoint."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{url.rstrip('/')}{path}", timeout=3.0)
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _sum_prefix_cache(raw: dict[str, Any], prefix: str) -> dict[str, float]:
    """Extract prefix cache token counters from parsed Prometheus metrics."""
    total_in = 0.0
    cached_in = 0.0
    requests = 0.0
    est_cost = 0.0
    act_cost = 0.0
    for key, val in raw.items():
        metric_val = (
            val["value"] if isinstance(val, dict) and "value" in val else val if isinstance(val, (int, float)) else 0
        )
        full_name = key if isinstance(key, str) else ""
        if full_name.startswith(f"{prefix}_token_total"):
            if "cache_status" in full_name and '"cached"' in full_name:
                cached_in += float(metric_val)
            total_in += float(metric_val)
        elif full_name.startswith(f"{prefix}_request_total"):
            requests += float(metric_val)
        elif full_name.startswith(f"{prefix}_cost_estimated_usd_total"):
            est_cost += float(metric_val)
        elif full_name.startswith(f"{prefix}_cost_actual_usd_total"):
            act_cost += float(metric_val)
    return {
        "total_prompt_tokens": total_in,
        "cached_prompt_tokens": cached_in,
        "requests": requests,
        "estimated_cost_usd": est_cost,
        "actual_cost_usd": act_cost,
    }


async def get_extended_cache_metrics() -> dict[str, Any]:
    """Unified prefix cache metrics from planner-ts, yarn-ts, and health endpoints."""
    import asyncio

    planner_raw, yarn_raw, planner_health, yarn_health = await asyncio.gather(
        _fetch_service_metrics(PLANNER_TS_URL),
        _fetch_service_metrics(YARN_TS_URL),
        _fetch_service_health(PLANNER_TS_URL, "/health"),
        _fetch_service_health(YARN_TS_URL, "/health/telemetry"),
        return_exceptions=True,
    )
    if isinstance(planner_raw, BaseException):
        planner_raw = {}
    if isinstance(yarn_raw, BaseException):
        yarn_raw = {}
    if isinstance(planner_health, BaseException):
        planner_health = {}
    if isinstance(yarn_health, BaseException):
        yarn_health = {}

    p = _sum_prefix_cache(planner_raw, "synesis_planner")
    y = _sum_prefix_cache(yarn_raw, "synesis_yarn")

    p_prompt = p["total_prompt_tokens"]
    p_cached = p["cached_prompt_tokens"]
    y_prompt = y["total_prompt_tokens"]
    y_cached = y["cached_prompt_tokens"]

    planner_mode = (
        planner_health.get("llm", {}).get("prefixCacheMode", "auto") if isinstance(planner_health, dict) else "auto"
    )

    planner_block = {
        "hit_rate": round(p_cached / p_prompt, 4) if p_prompt > 0 else 0.0,
        "cached_prompt_tokens": int(p_cached),
        "total_prompt_tokens": int(p_prompt),
        "mode": planner_mode,
        "requests": int(p["requests"]),
        "estimated_savings_usd": round(p["estimated_cost_usd"], 6),
    }

    yarn_block = {
        "hit_rate": round(y_cached / y_prompt, 4) if y_prompt > 0 else 0.0,
        "cached_prompt_tokens": int(y_cached),
        "total_prompt_tokens": int(y_prompt),
        "requests": int(y["requests"]),
        "estimated_savings_usd": round(y["estimated_cost_usd"], 6),
    }

    total_prompt = p_prompt + y_prompt
    total_cached = p_cached + y_cached

    redis_info: dict[str, Any] = {}
    if isinstance(planner_health, dict):
        redis_info = {
            "status": "connected" if planner_health.get("redis", {}).get("configured") else "not_configured",
        }
        session_data = planner_health.get("session", {})
        if session_data:
            redis_info["total_keys"] = session_data.get("count", 0)

    sessions_info: dict[str, Any] = {}
    if isinstance(planner_health, dict):
        ps = planner_health.get("session", {})
        sessions_info["planner"] = {
            "backend": ps.get("backend", "unknown"),
            "count": ps.get("count", 0),
            "checkpoints": ps.get("checkpoints", 0),
        }
    if isinstance(yarn_health, dict):
        sc = yarn_health.get("sawtoothContext", {})
        sessions_info["yarn"] = {
            "active": sc.get("activeSessionCount", 0),
            "persisted": True,
        }

    return {
        "planner": planner_block,
        "yarn": yarn_block,
        "redis": redis_info,
        "sessions": sessions_info,
        "hit_rate": round(total_cached / total_prompt, 4) if total_prompt > 0 else 0.0,
        "exact_hits": 0,
        "semantic_hits": 0,
        "misses": 0,
        "evictions": 0,
        "entries": 0,
    }


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


async def get_token_budget_metrics() -> dict[str, Any]:
    """Aggregate token-budget health signals from planner Prometheus metrics."""
    raw = await fetch_planner_metrics()
    if not raw:
        return {}

    remaining = _find_metric(raw, "synesis_token_budget_remaining")
    exhausted = _find_metric(raw, "synesis_token_budget_exhausted_total")
    degraded = _find_metric(raw, "synesis_token_budget_degraded_total")
    anomaly_trips = _find_metric(raw, "synesis_token_budget_anomaly_trips_total")

    overspend_by_node: dict[str, int] = {}
    for key, entry in raw.items():
        if "synesis_token_budget_overspend_total" not in key:
            continue
        if isinstance(entry, dict):
            node = (entry.get("labels") or {}).get("node", "unknown")
            overspend_by_node[node] = overspend_by_node.get(node, 0) + int(entry.get("value", 0))

    return {
        "remaining_last": int(remaining),
        "exhausted_total": int(exhausted),
        "degraded_total": int(degraded),
        "anomaly_trips_total": int(anomaly_trips),
        "overspend_by_node": overspend_by_node,
        "risk_level": ("critical" if exhausted > 0 or anomaly_trips > 0 else "warning" if degraded > 0 else "healthy"),
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
