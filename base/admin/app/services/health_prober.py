"""Async health probes for platform services."""

from __future__ import annotations

import asyncio
import time

import httpx

from ..deps import LITELLM_URL

CORE_SERVICES = [
    {"name": "synesis-planner", "url": "http://synesis-planner.synesis-planner.svc.cluster.local:8000/health"},
    {"name": "milvus", "url": "http://synesis-milvus.synesis-rag.svc.cluster.local:9091/healthz"},
    {"name": "embedder", "url": "http://embedder.synesis-rag.svc.cluster.local:8080/health"},
    {"name": "keyword-service", "url": "http://keyword-service.synesis-rag.svc.cluster.local:8080/health"},
    {"name": "lsp-gateway", "url": "http://lsp-gateway.synesis-lsp.svc:8000/health"},
    {"name": "litellm-proxy", "url": "http://litellm-proxy.synesis-gateway.svc.cluster.local:4000/health"},
    {"name": "mcp-server", "url": "http://synesis-mcp.synesis-planner.svc.cluster.local:8080/health"},
]

MODEL_SERVICES = [
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
        results.append({
            "name": model,
            "status": "ok",
            "status_code": 200,
            "latency_ms": None,
            "error": None,
            "category": "model-gateway",
        })
    for ep in unhealthy:
        model = ep.get("model", "unknown")
        error_msg = ep.get("error", "unhealthy")
        results.append({
            "name": model,
            "status": "error",
            "status_code": None,
            "latency_ms": None,
            "error": str(error_msg)[:80],
            "category": "model-gateway",
        })
    return results


async def probe_all() -> list[dict]:
    async with httpx.AsyncClient() as client:
        # Always probe CORE_SERVICES concurrently
        core_tasks = [
            probe_service(client, svc, category="infrastructure")
            for svc in CORE_SERVICES
        ]
        core_results = await asyncio.gather(*core_tasks)

        # Try LiteLLM model health first (OpenRouter mode)
        model_results: list[dict] = []
        litellm_models = await probe_litellm_models(client)
        if litellm_models:
            model_results = litellm_models
        else:
            # Fall back to direct vLLM probes (local mode)
            model_tasks = [
                probe_service(client, svc, category="model")
                for svc in MODEL_SERVICES
            ]
            model_results = await asyncio.gather(*model_tasks)

        return list(core_results) + list(model_results)
