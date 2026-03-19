"""HTTP client for LiteLLM Proxy management API (model CRUD without restart)."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..deps import LITELLM_MASTER_KEY, LITELLM_URL

logger = logging.getLogger("synesis.admin.litellm_client")


def _headers() -> dict[str, str]:
    h: dict[str, str] = {"Content-Type": "application/json"}
    if LITELLM_MASTER_KEY:
        h["Authorization"] = f"Bearer {LITELLM_MASTER_KEY}"
    return h


def _base() -> str:
    return LITELLM_URL.rstrip("/")


async def list_models(timeout: float = 10.0) -> list[dict[str, Any]]:
    """GET /model/info — returns list of models currently registered in LiteLLM."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{_base()}/model/info", headers=_headers(), timeout=timeout)
            resp.raise_for_status()
            data = resp.json().get("data", [])
            return data
    except Exception:
        logger.warning("litellm_list_models_failed", exc_info=True)
        return []


async def add_model(
    model_name: str,
    litellm_params: dict[str, Any],
    model_info: dict[str, Any] | None = None,
    timeout: float = 10.0,
) -> dict[str, Any] | None:
    """POST /model/new — register a new model route (hot reload, no restart)."""
    payload: dict[str, Any] = {
        "model_name": model_name,
        "litellm_params": litellm_params,
    }
    if model_info:
        payload["model_info"] = model_info
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{_base()}/model/new", json=payload, headers=_headers(), timeout=timeout
            )
            resp.raise_for_status()
            return resp.json()
    except Exception:
        logger.warning("litellm_add_model_failed model=%s", model_name, exc_info=True)
        return None


async def delete_model(model_id: str, timeout: float = 10.0) -> bool:
    """POST /model/delete — remove a model route by its LiteLLM ID."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{_base()}/model/delete",
                json={"id": model_id},
                headers=_headers(),
                timeout=timeout,
            )
            resp.raise_for_status()
            return True
    except Exception:
        logger.warning("litellm_delete_model_failed id=%s", model_id, exc_info=True)
        return False


async def set_fallbacks(
    fallback_map: list[dict[str, list[str]]],
    timeout: float = 10.0,
) -> bool:
    """POST /fallbacks — configure model fallback mappings in LiteLLM.

    ``fallback_map`` is a list like [{"synesis-general": ["synesis-general-fb"]}].
    """
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{_base()}/fallbacks",
                json={"fallbacks": fallback_map},
                headers=_headers(),
                timeout=timeout,
            )
            resp.raise_for_status()
            return True
    except Exception:
        logger.warning("litellm_set_fallbacks_failed", exc_info=True)
        return False


async def health_check(timeout: float = 5.0) -> dict[str, Any] | None:
    """GET /health — probe LiteLLM proxy health."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{_base()}/health", headers=_headers(), timeout=timeout)
            resp.raise_for_status()
            return resp.json()
    except Exception:
        return None
