"""Async health probes for platform services — deployment-aware."""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

from ..deps import LITELLM_URL

logger = logging.getLogger("synesis.admin.health_prober")

CORE_SERVICES = [
    {"name": "synesis-planner", "url": "http://synesis-planner.synesis-planner.svc.cluster.local:8000/health"},
    {"name": "milvus", "url": "http://synesis-milvus.synesis-rag.svc.cluster.local:9091/healthz"},
    {"name": "embedder", "url": "http://embedder.synesis-rag.svc.cluster.local:8080/health"},
    {"name": "keyword-service", "url": "http://keyword-service.synesis-rag.svc.cluster.local:8080/health"},
    {"name": "lsp-gateway", "url": "http://lsp-gateway.synesis-lsp.svc:8000/health"},
    {"name": "litellm-proxy", "url": "http://litellm-proxy.synesis-gateway.svc.cluster.local:4000/health"},
    {"name": "mcp-server", "url": "http://synesis-mcp.synesis-planner.svc.cluster.local:8080/health"},
]

STATIC_MODEL_SERVICES = [
    {"name": "synesis-router", "url": "http://synesis-router.synesis-models.svc.cluster.local:8080/health"},
    {"name": "synesis-general", "url": "http://synesis-general.synesis-models.svc.cluster.local:8080/health"},
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


async def probe_litellm_models(client: httpx.AsyncClient) -> list[dict] | None:
    """Probe LiteLLM /health for model endpoint status. Returns None on error or empty."""
    url = f"{LITELLM_URL.rstrip('/')}/health"
    try:
        resp = await client.get(url, timeout=5.0)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return None

    healthy = data.get("healthy_endpoints") or []
    unhealthy = data.get("unhealthy_endpoints") or []
    if not healthy and not unhealthy:
        return None

    results: list[dict] = []
    for ep in healthy:
        model = ep.get("model", "unknown")
        results.append(
            {
                "name": model,
                "status": "ok",
                "status_code": 200,
                "latency_ms": None,
                "error": None,
                "category": "model-gateway",
            }
        )
    for ep in unhealthy:
        model = ep.get("model", "unknown")
        error_msg = ep.get("error", "unhealthy")
        results.append(
            {
                "name": model,
                "status": "error",
                "status_code": None,
                "latency_ms": None,
                "error": str(error_msg)[:80],
                "category": "model-gateway",
            }
        )
    return results


async def _get_active_vllm_probes() -> list[dict]:
    """Build model probe list from DB active deployments. Only vLLM-sourced models
    get direct health probes; OpenRouter/external models are covered by LiteLLM /health."""
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


async def probe_all() -> list[dict]:
    async with httpx.AsyncClient() as client:
        core_tasks = [probe_service(client, svc, category="infrastructure") for svc in CORE_SERVICES]
        core_results = await asyncio.gather(*core_tasks)

        model_results: list[dict] = []
        litellm_models = await probe_litellm_models(client)
        if litellm_models:
            model_results = litellm_models
        else:
            vllm_probes = await _get_active_vllm_probes()
            if vllm_probes:
                model_tasks = [probe_service(client, svc, category="model") for svc in vllm_probes]
                model_results = await asyncio.gather(*model_tasks)

        return list(core_results) + list(model_results)
