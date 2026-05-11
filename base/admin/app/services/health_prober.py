"""Async health probes for platform services — deployment-aware."""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

logger = logging.getLogger("synesis.admin.health_prober")

CORE_SERVICES = [
    {"name": "synesis-planner-ts", "url": "http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080/health"},
    {"name": "nornicdb", "url": "http://synesis-nornicdb.synesis-rag.svc.cluster.local:7474"},
    {"name": "embedder", "url": "http://embedder.synesis-rag.svc.cluster.local:8080/health"},
    {"name": "keyword-service", "url": "http://keyword-service.synesis-rag.svc.cluster.local:8080/health"},
    {"name": "synesis-mcp-ts", "url": "http://synesis-mcp-ts.synesis-yarn.svc.cluster.local:8100/health"},
    {"name": "synesis-yarn", "url": "http://synesis-yarn.synesis-yarn.svc.cluster.local:8000/health"},
]

STATIC_MODEL_SERVICES = [
    {"name": "synesis-router", "url": "http://synesis-router.synesis-models.svc.cluster.local:8080/health"},
    {"name": "synesis-writer", "url": "http://synesis-writer.synesis-models.svc.cluster.local:8080/health"},
    {"name": "synesis-critic", "url": "http://synesis-critic.synesis-models.svc.cluster.local:8080/health"},
]


async def probe_service(
    client: httpx.AsyncClient,
    svc: dict,
    timeout: float = 5.0,
    category: str = "infrastructure",
) -> dict:
    t0 = time.monotonic()
    try:
        resp = await client.get(svc["url"], timeout=timeout)
        elapsed = (time.monotonic() - t0) * 1000
        return {
            "name": svc["name"],
            "status": "ok" if resp.status_code < 500 else "error",
            "status_code": resp.status_code,
            "latency_ms": round(elapsed, 1),
            "error": None,
            "category": category,
        }
    except Exception as exc:
        elapsed = (time.monotonic() - t0) * 1000
        return {
            "name": svc["name"],
            "status": "error",
            "status_code": None,
            "latency_ms": round(elapsed, 1),
            "error": str(exc)[:80],
            "category": category,
        }


async def _get_active_vllm_probes() -> list[dict]:
    """Build model probe list from DB active deployments. Only vLLM-sourced models
    get direct health probes; remote API providers do not expose a shared local health endpoint."""
    try:
        from .model_registry import get_active_deployments

        active = await get_active_deployments()
        if not active:
            return STATIC_MODEL_SERVICES

        has_any_active = len(active) > 0
        vllm_probes = []
        for dep in active:
            if dep.source in ("openrouter", "external"):
                continue
            endpoint = dep.endpoint or ""
            if endpoint:
                health_url = endpoint.rstrip("/").rsplit("/v1", 1)[0] + "/health"
                vllm_probes.append({"name": dep.served_name or dep.role, "url": health_url})

        if has_any_active and not vllm_probes:
            return []

        return vllm_probes if vllm_probes else STATIC_MODEL_SERVICES
    except Exception:
        logger.debug("active_vllm_probes_fallback", exc_info=True)
        return STATIC_MODEL_SERVICES


async def scrape_vllm_prefix_cache_metrics(
    client: httpx.AsyncClient,
    vllm_probes: list[dict],
    timeout: float = 3.0,
) -> dict[str, dict]:
    """Scrape vLLM /metrics for prefix cache hit rates.

    Returns {model_name: {"prefix_cache_hit_rate": float, "prefix_cache_queries": int}}
    """
    import re as _re

    _HIT_RE = _re.compile(r"vllm:prefix_cache_hit_rate\s+([\d.]+)")
    _QUERIES_RE = _re.compile(r"vllm:prefix_cache_queries_total\s+([\d.]+)")

    results: dict[str, dict] = {}
    for probe in vllm_probes:
        name = probe["name"]
        metrics_url = probe["url"].replace("/health", "/metrics")
        try:
            resp = await client.get(metrics_url, timeout=timeout)
            if resp.status_code != 200:
                continue
            text = resp.text
            hit_m = _HIT_RE.search(text)
            queries_m = _QUERIES_RE.search(text)
            entry: dict = {}
            if hit_m:
                entry["prefix_cache_hit_rate"] = round(float(hit_m.group(1)), 4)
            if queries_m:
                entry["prefix_cache_queries"] = int(float(queries_m.group(1)))
            if entry:
                results[name] = entry
        except Exception:
            logger.debug("vllm_metrics_scrape_failed", extra={"model": name}, exc_info=True)
    return results


async def probe_all() -> list[dict]:
    async with httpx.AsyncClient() as client:
        core_tasks = [probe_service(client, svc, category="infrastructure") for svc in CORE_SERVICES]
        core_results = await asyncio.gather(*core_tasks)

        model_results: list[dict] = []
        vllm_probes = await _get_active_vllm_probes()

        if vllm_probes:
            model_tasks = [probe_service(client, svc, category="model") for svc in vllm_probes]
            model_results = list(await asyncio.gather(*model_tasks))

        # Scrape prefix cache metrics from vLLM endpoints
        cache_metrics: dict[str, dict] = {}
        if vllm_probes:
            cache_metrics = await scrape_vllm_prefix_cache_metrics(client, vllm_probes)
            for result in model_results:
                cm = cache_metrics.get(result["name"])
                if cm:
                    result["prefix_cache"] = cm

        return list(core_results) + model_results
