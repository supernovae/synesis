"""Provider API key management — read/write the provider-api-keys K8s secret."""

from __future__ import annotations

import base64
import logging
import os
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_current_user, require_admin
from ..services.provider_catalog import PROVIDER_CATALOG, get_catalog

logger = logging.getLogger("synesis.admin.providers")

router = APIRouter(prefix="/api/v1/providers", tags=["providers"])

_SECRET_NAME = "provider-api-keys"
_SECRET_NAMESPACE = os.environ.get("SYNESIS_GATEWAY_NAMESPACE", "synesis-gateway")
_LITELLM_DEPLOYMENT = "litellm-proxy"

_SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
_SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
_K8S_HOST = os.environ.get("KUBERNETES_SERVICE_HOST", "")
_K8S_PORT = os.environ.get("KUBERNETES_SERVICE_PORT", "443")

KNOWN_PROVIDERS = {
    p.api_key_env: p.label
    for p in PROVIDER_CATALOG.values()
    if p.api_key_env
}


def _k8s_base() -> str:
    return f"https://{_K8S_HOST}:{_K8S_PORT}"


def _k8s_headers() -> dict[str, str]:
    try:
        with open(_SA_TOKEN_PATH) as f:
            token = f.read().strip()
    except FileNotFoundError:
        raise HTTPException(503, "Not running in-cluster (no service account token)")
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _k8s_verify() -> str | bool:
    if os.path.exists(_SA_CA_PATH):
        return _SA_CA_PATH
    return False


async def _get_secret() -> dict | None:
    url = f"{_k8s_base()}/api/v1/namespaces/{_SECRET_NAMESPACE}/secrets/{_SECRET_NAME}"
    try:
        async with httpx.AsyncClient(verify=_k8s_verify()) as client:
            resp = await client.get(url, headers=_k8s_headers(), timeout=10)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError:
        logger.warning("k8s_get_secret_failed", exc_info=True)
        raise HTTPException(502, "Failed to read provider keys from cluster")


async def _create_secret(data: dict[str, str]) -> None:
    url = f"{_k8s_base()}/api/v1/namespaces/{_SECRET_NAMESPACE}/secrets"
    encoded = {k: base64.b64encode(v.encode()).decode() for k, v in data.items()}
    body = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {
            "name": _SECRET_NAME,
            "namespace": _SECRET_NAMESPACE,
            "labels": {
                "app.kubernetes.io/part-of": "synesis",
                "app.kubernetes.io/component": "gateway",
            },
        },
        "type": "Opaque",
        "data": encoded,
    }
    async with httpx.AsyncClient(verify=_k8s_verify()) as client:
        resp = await client.post(url, headers=_k8s_headers(), json=body, timeout=10)
        resp.raise_for_status()


async def _patch_secret(data: dict[str, str]) -> None:
    url = f"{_k8s_base()}/api/v1/namespaces/{_SECRET_NAMESPACE}/secrets/{_SECRET_NAME}"
    encoded = {k: base64.b64encode(v.encode()).decode() for k, v in data.items()}
    body = {"data": encoded}
    headers = {**_k8s_headers(), "Content-Type": "application/strategic-merge-patch+json"}
    async with httpx.AsyncClient(verify=_k8s_verify()) as client:
        resp = await client.patch(url, headers=headers, json=body, timeout=10)
        resp.raise_for_status()


async def _remove_key_from_secret(key: str) -> None:
    secret = await _get_secret()
    if not secret:
        return
    current_data = secret.get("data", {})
    if key not in current_data:
        return
    del current_data[key]
    url = f"{_k8s_base()}/api/v1/namespaces/{_SECRET_NAMESPACE}/secrets/{_SECRET_NAME}"
    body = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": _SECRET_NAME, "namespace": _SECRET_NAMESPACE},
        "type": "Opaque",
        "data": current_data,
    }
    async with httpx.AsyncClient(verify=_k8s_verify()) as client:
        resp = await client.put(url, headers=_k8s_headers(), json=body, timeout=10)
        resp.raise_for_status()


async def _restart_litellm() -> None:
    """Trigger a rollout restart by patching a pod template annotation."""
    url = (
        f"{_k8s_base()}/apis/apps/v1/namespaces/{_SECRET_NAMESPACE}"
        f"/deployments/{_LITELLM_DEPLOYMENT}"
    )
    body = {
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "synesis.io/restart-trigger": str(int(time.time()))
                    }
                }
            }
        }
    }
    headers = {**_k8s_headers(), "Content-Type": "application/strategic-merge-patch+json"}
    try:
        async with httpx.AsyncClient(verify=_k8s_verify()) as client:
            resp = await client.patch(url, headers=headers, json=body, timeout=10)
            resp.raise_for_status()
            logger.info("litellm_restart_triggered")
    except Exception:
        logger.warning("litellm_restart_failed", exc_info=True)


@router.get("/catalog")
async def provider_catalog(_user=Depends(get_current_user)):
    """Return the provider catalog and canonical role list for the frontend."""
    return get_catalog()


@router.get("/keys")
async def list_keys(_user=Depends(get_current_user)):
    """List provider key names and whether each is configured. Never returns values."""
    secret = await _get_secret()
    configured_keys = set()
    if secret and secret.get("data"):
        configured_keys = set(secret["data"].keys())

    keys = []
    all_names = set(KNOWN_PROVIDERS.keys()) | configured_keys
    for name in sorted(all_names):
        keys.append({
            "name": name,
            "provider": KNOWN_PROVIDERS.get(name, "Custom"),
            "configured": name in configured_keys,
        })
    return {"keys": keys}


class SetKeyRequest(BaseModel):
    value: str


@router.put("/keys/{name}")
async def set_key(name: str, body: SetKeyRequest, _user=Depends(require_admin)):
    """Set or rotate a provider API key. Triggers LiteLLM restart."""
    name = name.upper()
    if not body.value.strip():
        raise HTTPException(400, "Key value cannot be empty")

    secret = await _get_secret()
    if secret is None:
        await _create_secret({name: body.value.strip()})
    else:
        await _patch_secret({name: body.value.strip()})

    await _restart_litellm()
    logger.info("provider_key_set name=%s", name)
    return {"ok": True, "name": name, "restart": True}


@router.delete("/keys/{name}")
async def delete_key(name: str, _user=Depends(require_admin)):
    """Remove a provider API key. Triggers LiteLLM restart."""
    name = name.upper()
    await _remove_key_from_secret(name)
    await _restart_litellm()
    logger.info("provider_key_deleted name=%s", name)
    return {"ok": True, "name": name, "restart": True}
