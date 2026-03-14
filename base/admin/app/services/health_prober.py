"""Async health probes for platform services."""

from __future__ import annotations

import time

import httpx

STATUS_SERVICES = [
    {"name": "synesis-router", "url": "http://synesis-router.synesis-models.svc.cluster.local:8080/health"},
    {"name": "synesis-general", "url": "http://synesis-general.synesis-models.svc.cluster.local:8080/health"},
    {"name": "synesis-critic", "url": "http://synesis-critic.synesis-models.svc.cluster.local:8080/health"},
    {"name": "synesis-planner", "url": "http://synesis-planner.synesis-planner.svc.cluster.local:8000/health"},
    {"name": "milvus", "url": "http://synesis-milvus.synesis-rag.svc.cluster.local:9091/healthz"},
    {"name": "embedder", "url": "http://embedder.synesis-rag.svc.cluster.local:8080/health"},
    {"name": "keyword-service", "url": "http://keyword-service.synesis-rag.svc.cluster.local:8080/health"},
    {"name": "lsp-gateway", "url": "http://lsp-gateway.synesis-lsp.svc:8000/health"},
    {"name": "litellm-proxy", "url": "http://litellm-proxy.synesis-gateway.svc.cluster.local:4000/health"},
    {"name": "mcp-server", "url": "http://synesis-mcp.synesis-planner.svc.cluster.local:8080/health"},
]


async def probe_service(client: httpx.AsyncClient, svc: dict, timeout: float = 5.0) -> dict:
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
        }
    except Exception as exc:
        elapsed = (time.monotonic() - t0) * 1000
        return {
            "name": svc["name"],
            "status": "error",
            "status_code": None,
            "latency_ms": round(elapsed, 1),
            "error": str(exc)[:80],
        }


async def probe_all() -> list[dict]:
    async with httpx.AsyncClient() as client:
        results = []
        for svc in STATUS_SERVICES:
            results.append(await probe_service(client, svc))
        return results
