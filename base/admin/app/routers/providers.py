"""Provider API key management — read/write the provider-api-keys K8s secret."""

from __future__ import annotations

import base64
import logging
import os
import time
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from ..auth import UserInfo, get_current_user, require_admin
from ..db.engine import async_session
from ..db.models import ProviderConfig
from ..services.admin_audit import record_admin_audit
from ..services.provider_catalog import PROVIDER_CATALOG, default_endpoint_for_provider, get_catalog
from ..services.provider_discovery import (
    discover_models,
    get_defaults_for_model,
    supported_discovery_providers,
    validate_model_id,
)

logger = logging.getLogger("synesis.admin.providers")

router = APIRouter(prefix="/api/v1/providers", tags=["providers"])

_SECRET_NAME = "provider-api-keys"
_SECRET_NAMESPACE = os.environ.get("SYNESIS_GATEWAY_NAMESPACE", "synesis-gateway")
_LITELLM_DEPLOYMENT = "litellm-proxy"

_SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
_SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
_K8S_HOST = os.environ.get("KUBERNETES_SERVICE_HOST", "")
_K8S_PORT = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
_HTTP_TIMEOUT_SECONDS = 10

KNOWN_PROVIDERS = {p.api_key_env: p.label for p in PROVIDER_CATALOG.values() if p.api_key_env}

# Only catalog env var names may be set via PUT /keys/{name} (same list as Model Registry provider picklist).
_ALLOWED_KEY_ENV_NAMES = frozenset(KNOWN_PROVIDERS.keys())


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


def _k8s_error_detail(action: str, exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        body = (exc.response.text or "").strip()
        if body:
            body = body[:300]
            return f"{action} failed with status {status}: {body}"
        return f"{action} failed with status {status}"
    if isinstance(exc, httpx.RequestError):
        return f"{action} failed due to cluster connectivity error: {exc}"
    return f"{action} failed: {exc}"


async def _audit_best_effort(
    *,
    user: UserInfo,
    action: str,
    status: str,
    summary: str,
    detail: dict | None = None,
) -> None:
    try:
        await record_admin_audit(
            user=user,
            action=action,
            status=status,
            summary=summary,
            detail=detail or {},
        )
    except Exception:
        logger.warning("provider_audit_failed action=%s status=%s", action, status, exc_info=True)


async def _get_secret() -> dict | None:
    url = f"{_k8s_base()}/api/v1/namespaces/{_SECRET_NAMESPACE}/secrets/{_SECRET_NAME}"
    try:
        async with httpx.AsyncClient(verify=_k8s_verify()) as client:
            resp = await client.get(url, headers=_k8s_headers(), timeout=_HTTP_TIMEOUT_SECONDS)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json()
    except (httpx.HTTPStatusError, httpx.RequestError) as exc:
        logger.warning("k8s_get_secret_failed", exc_info=True)
        raise HTTPException(502, _k8s_error_detail("Reading provider key secret", exc))


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
    try:
        async with httpx.AsyncClient(verify=_k8s_verify()) as client:
            resp = await client.post(url, headers=_k8s_headers(), json=body, timeout=_HTTP_TIMEOUT_SECONDS)
            resp.raise_for_status()
    except (httpx.HTTPStatusError, httpx.RequestError) as exc:
        logger.warning("k8s_create_secret_failed", exc_info=True)
        raise HTTPException(502, _k8s_error_detail("Creating provider key secret", exc))


async def _patch_secret(data: dict[str, str]) -> None:
    url = f"{_k8s_base()}/api/v1/namespaces/{_SECRET_NAMESPACE}/secrets/{_SECRET_NAME}"
    encoded = {k: base64.b64encode(v.encode()).decode() for k, v in data.items()}
    body = {"data": encoded}
    headers = {**_k8s_headers(), "Content-Type": "application/strategic-merge-patch+json"}
    try:
        async with httpx.AsyncClient(verify=_k8s_verify()) as client:
            resp = await client.patch(url, headers=headers, json=body, timeout=_HTTP_TIMEOUT_SECONDS)
            resp.raise_for_status()
    except (httpx.HTTPStatusError, httpx.RequestError) as exc:
        logger.warning("k8s_patch_secret_failed", exc_info=True)
        raise HTTPException(502, _k8s_error_detail("Updating provider key secret", exc))


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
    try:
        async with httpx.AsyncClient(verify=_k8s_verify()) as client:
            resp = await client.put(url, headers=_k8s_headers(), json=body, timeout=_HTTP_TIMEOUT_SECONDS)
            resp.raise_for_status()
    except (httpx.HTTPStatusError, httpx.RequestError) as exc:
        logger.warning("k8s_remove_key_failed key=%s", key, exc_info=True)
        raise HTTPException(502, _k8s_error_detail(f"Removing provider key {key}", exc))


async def _restart_litellm() -> None:
    """Trigger a rollout restart by patching a pod template annotation."""
    url = f"{_k8s_base()}/apis/apps/v1/namespaces/{_SECRET_NAMESPACE}/deployments/{_LITELLM_DEPLOYMENT}"
    body = {"spec": {"template": {"metadata": {"annotations": {"synesis.io/restart-trigger": str(int(time.time()))}}}}}
    headers = {**_k8s_headers(), "Content-Type": "application/strategic-merge-patch+json"}
    try:
        async with httpx.AsyncClient(verify=_k8s_verify()) as client:
            resp = await client.patch(url, headers=headers, json=body, timeout=_HTTP_TIMEOUT_SECONDS)
            resp.raise_for_status()
            logger.info("litellm_restart_triggered")
    except (httpx.HTTPStatusError, httpx.RequestError) as exc:
        logger.warning("litellm_restart_failed", exc_info=True)
        detail = (
            f"{_k8s_error_detail('Restarting LiteLLM deployment', exc)}. "
            "Provider key was saved, but LiteLLM may still have stale env vars. "
            "Run: oc rollout restart deployment/litellm-proxy -n synesis-gateway"
        )
        raise HTTPException(502, detail)


async def _assert_key_state(name: str, *, should_exist: bool) -> None:
    secret = await _get_secret()
    current_data = set((secret or {}).get("data", {}).keys())
    exists = name in current_data
    if should_exist and not exists:
        raise HTTPException(
            502,
            f"Provider key {name} write did not persist in {_SECRET_NAMESPACE}/{_SECRET_NAME}. "
            "Please retry and check admin pod RBAC/logs.",
        )
    if not should_exist and exists:
        raise HTTPException(
            502,
            f"Provider key {name} delete did not persist in {_SECRET_NAMESPACE}/{_SECRET_NAME}. "
            "Please retry and check admin pod RBAC/logs.",
        )


async def _get_litellm_deployment() -> dict:
    url = f"{_k8s_base()}/apis/apps/v1/namespaces/{_SECRET_NAMESPACE}/deployments/{_LITELLM_DEPLOYMENT}"
    try:
        async with httpx.AsyncClient(verify=_k8s_verify()) as client:
            resp = await client.get(url, headers=_k8s_headers(), timeout=_HTTP_TIMEOUT_SECONDS)
            resp.raise_for_status()
            return resp.json()
    except (httpx.HTTPStatusError, httpx.RequestError) as exc:
        logger.warning("k8s_get_litellm_deployment_failed", exc_info=True)
        raise HTTPException(502, _k8s_error_detail("Reading LiteLLM deployment status", exc))


def _coerce_int(value: object) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


@router.get("/catalog")
async def provider_catalog(_user=Depends(get_current_user)):
    """Return the provider catalog and canonical role list for the frontend.

    Filters out providers disabled in Provider Management and merges in custom
    providers so the Model Registry picklist stays in sync with a single source
    of truth.
    """
    from ..routers.provider_governance import _get_custom_rows, get_disabled_provider_keys

    catalog = get_catalog()
    disabled = await get_disabled_provider_keys()
    providers = {k: v for k, v in catalog["providers"].items() if k not in disabled}

    custom_rows = await _get_custom_rows()
    for r in custom_rows:
        if r.provider_key not in providers and r.enabled:
            providers[r.provider_key] = {
                "key": r.provider_key,
                "label": r.label or r.provider_key,
                "litellm_prefix": r.litellm_prefix or "openai/",
                "api_key_env": r.api_key_env or "",
                "needs_endpoint": r.needs_endpoint if r.needs_endpoint is not None else True,
                "placeholder": r.placeholder or "model-name",
                "is_local": r.is_local or False,
                "supports_discovery": False,
                "is_custom": True,
            }

    overlays: dict[str, str] = {}
    async with async_session() as session:
        result = await session.execute(select(ProviderConfig.provider_key, ProviderConfig.default_endpoint))
        for pk, de in result.all():
            if de and str(de).strip():
                overlays[str(pk)] = str(de).strip()
    for k, v in providers.items():
        override = overlays.get(k, "").strip()
        base = default_endpoint_for_provider(k)
        v["default_endpoint"] = override or base

    return {**catalog, "providers": providers}


@router.get("/discovery/supported")
async def discovery_supported(_user=Depends(get_current_user)):
    """List provider keys that support model discovery."""
    return {"providers": supported_discovery_providers()}


@router.get("/discovery/{provider_key}/models")
async def discovery_models(
    provider_key: str,
    bypass_cache: bool = False,
    _user=Depends(get_current_user),
):
    """Fetch available models from a provider's API.

    Results are cached for 5 minutes.  Pass ``?bypass_cache=true`` to force a
    fresh fetch.
    """
    result = await discover_models(provider_key, bypass_cache=bypass_cache)
    return result.to_dict()


@router.get("/discovery/{provider_key}/defaults")
async def discovery_defaults(
    provider_key: str,
    model_id: str = "",
    context_window: int | None = None,
    _user=Depends(get_current_user),
):
    """Get recommended LiteLLM defaults for a provider + model pair."""
    defaults = get_defaults_for_model(provider_key, model_id, context_window)
    return defaults.to_dict()


@router.post("/discovery/validate")
async def discovery_validate(
    body: dict,
    _user=Depends(get_current_user),
):
    """Validate a model ID for a given provider and return hints."""
    provider_key = body.get("provider", "")
    model_id = body.get("model", "")
    return validate_model_id(provider_key, model_id)


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
        keys.append(
            {
                "name": name,
                "provider": KNOWN_PROVIDERS.get(name, "Custom"),
                "configured": name in configured_keys,
            }
        )
    return {"keys": keys}


@router.get("/litellm/restart-status")
async def litellm_restart_status(_user=Depends(get_current_user)):
    dep = await _get_litellm_deployment()
    md = dep.get("metadata", {})
    spec = dep.get("spec", {})
    status = dep.get("status", {})
    tmpl_md = (spec.get("template") or {}).get("metadata") or {}
    anns = tmpl_md.get("annotations") or {}

    restart_epoch = _coerce_int(anns.get("synesis.io/restart-trigger"))
    restart_at = datetime.fromtimestamp(restart_epoch, tz=UTC).isoformat() if restart_epoch is not None else None
    generation = _coerce_int(md.get("generation")) or 0
    observed_generation = _coerce_int(status.get("observedGeneration")) or 0
    desired = _coerce_int(spec.get("replicas")) or 0
    updated = _coerce_int(status.get("updatedReplicas")) or 0
    ready = _coerce_int(status.get("readyReplicas")) or 0
    available = _coerce_int(status.get("availableReplicas")) or 0

    return {
        "deployment": _LITELLM_DEPLOYMENT,
        "namespace": _SECRET_NAMESPACE,
        "restart_trigger_epoch": restart_epoch,
        "restart_trigger_at": restart_at,
        "generation": generation,
        "observed_generation": observed_generation,
        "rollout_observed": observed_generation >= generation,
        "desired_replicas": desired,
        "updated_replicas": updated,
        "ready_replicas": ready,
        "available_replicas": available,
    }


class SetKeyRequest(BaseModel):
    value: str


@router.put("/keys/{name}")
async def set_key(name: str, body: SetKeyRequest, user: UserInfo = Depends(require_admin)):
    """Set or rotate a provider API key. Triggers LiteLLM restart."""
    name = name.upper()
    if not body.value.strip():
        raise HTTPException(400, "Key value cannot be empty")
    from ..routers.provider_governance import _get_custom_rows as _custom

    custom_key_envs = {r.api_key_env for r in await _custom() if r.api_key_env}
    allowed = _ALLOWED_KEY_ENV_NAMES | custom_key_envs
    if name not in allowed:
        raise HTTPException(
            400,
            "Unknown key name. Only env vars from the provider catalog or custom providers may be set here.",
        )

    try:
        secret = await _get_secret()
        if secret is None:
            await _create_secret({name: body.value.strip()})
        else:
            await _patch_secret({name: body.value.strip()})
        await _assert_key_state(name, should_exist=True)
        await _restart_litellm()
    except HTTPException as exc:
        await _audit_best_effort(
            user=user,
            action="providers.key_set",
            status="error",
            summary=f"Failed to set provider key {name}",
            detail={"env_var": name, "error": str(exc.detail)},
        )
        raise

    logger.info("provider_key_set name=%s", name)
    await _audit_best_effort(
        user=user,
        action="providers.key_set",
        status="success",
        summary=f"Set provider key {name} and triggered LiteLLM rollout restart",
        detail={"env_var": name, "restart": True},
    )
    return {"ok": True, "name": name, "restart": True}


@router.delete("/keys/{name}")
async def delete_key(name: str, user: UserInfo = Depends(require_admin)):
    """Remove a provider API key. Triggers LiteLLM restart."""
    name = name.upper()
    from ..routers.provider_governance import _get_custom_rows as _custom

    custom_key_envs = {r.api_key_env for r in await _custom() if r.api_key_env}
    allowed = _ALLOWED_KEY_ENV_NAMES | custom_key_envs
    if name not in allowed:
        raise HTTPException(
            400,
            "Only catalog or custom provider keys can be removed here.",
        )
    try:
        await _remove_key_from_secret(name)
        await _assert_key_state(name, should_exist=False)
        await _restart_litellm()
    except HTTPException as exc:
        await _audit_best_effort(
            user=user,
            action="providers.key_delete",
            status="error",
            summary=f"Failed to remove provider key {name}",
            detail={"env_var": name, "error": str(exc.detail)},
        )
        raise

    logger.info("provider_key_deleted name=%s", name)
    await _audit_best_effort(
        user=user,
        action="providers.key_delete",
        status="success",
        summary=f"Removed provider key {name} and triggered LiteLLM rollout restart",
        detail={"env_var": name, "restart": True},
    )
    return {"ok": True, "name": name, "restart": True}
