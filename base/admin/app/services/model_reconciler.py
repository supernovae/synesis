"""Reconciler: syncs active model_deployments in DB to LiteLLM proxy via management API.

Uses ``resolve_deployment_routing_for_deployment`` so pushed routes always match
current ProviderConfig + catalog (same merge as Model Registry API), not stale
``litellm_params`` JSON frozen at last assign.
"""

from __future__ import annotations

import base64
import logging
import os

import httpx
from sqlalchemy import select

from ..db.engine import async_session
from ..db.models import ModelDeployment
from . import litellm_client
from .model_registry import (
    ProviderGovernanceMaps,
    load_provider_governance_maps,
    resolve_deployment_routing_for_deployment,
)

logger = logging.getLogger("synesis.admin.model_reconciler")

# LiteLLM routes defined in base/gateway/litellm-config.yaml but not represented as
# admin ModelDeployment rows (KNOWN_ROLES). Reconcile must not DELETE these via API —
# config-backed routes return 500 on /model/delete and should stay for Open WebUI / Yarn.
PROTECTED_MODELS = frozenset(
    {
        "synesis-agent",
        "Synesis",
        "Synesis Thinking",
        "synesis-thinking",
        "synesis-general-pulse",
        "synesis-general-core",
        "synesis-general-horizon",
        "synesis-pulse",
        "synesis-core",
        "synesis-horizon",
        "synesis-compaction",
    }
)

# Compared to detect routing drift (/model/info omits redacted secrets — omit api_key).
_ROUTING_KEYS = ("model", "api_base", "max_tokens", "temperature")
_SECRET_NAME = "provider-api-keys"
_SECRET_NAMESPACE = os.environ.get("SYNESIS_GATEWAY_NAMESPACE", "synesis-gateway")
_SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
_SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
_K8S_HOST = os.environ.get("KUBERNETES_SERVICE_HOST", "")
_K8S_PORT = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
_HTTP_TIMEOUT_SECONDS = 10


def _litellm_routing_differ(wanted: dict | None, got: dict | None) -> bool:
    if not wanted or not wanted.get("model"):
        return False
    g = got or {}
    for k in _ROUTING_KEYS:
        if wanted.get(k) != g.get(k):
            return True
    return False


def _index_litellm_by_name(litellm_models: list[dict]) -> dict[str, list[dict]]:
    by_name: dict[str, list[dict]] = {}
    for m in litellm_models:
        name = m.get("model_name", "")
        mid = m.get("model_info", {}).get("id", "")
        dep_id = m.get("model_info", {}).get("synesis_deployment_id")
        if name:
            by_name.setdefault(name, []).append({"id": mid, "raw": m, "deployment_id": dep_id})
    return by_name


def _k8s_base() -> str:
    return f"https://{_K8S_HOST}:{_K8S_PORT}"


def _k8s_verify() -> str | bool:
    return _SA_CA_PATH if os.path.exists(_SA_CA_PATH) else False


def _k8s_headers() -> dict[str, str]:
    try:
        with open(_SA_TOKEN_PATH) as f:
            token = f.read().strip()
    except FileNotFoundError:
        logger.warning("reconcile_k8s_sa_token_missing")
        return {}
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


async def _load_provider_api_keys() -> dict[str, str]:
    headers = _k8s_headers()
    if not headers:
        return {}
    url = f"{_k8s_base()}/api/v1/namespaces/{_SECRET_NAMESPACE}/secrets/{_SECRET_NAME}"
    try:
        async with httpx.AsyncClient(verify=_k8s_verify()) as client:
            resp = await client.get(url, headers=headers, timeout=_HTTP_TIMEOUT_SECONDS)
            if resp.status_code == 404:
                return {}
            resp.raise_for_status()
            data = (resp.json() or {}).get("data", {})
            out: dict[str, str] = {}
            for k, v in data.items():
                try:
                    out[k] = base64.b64decode(v).decode()
                except Exception:
                    logger.warning("reconcile_provider_key_decode_failed env=%s", k)
            return out
    except Exception:
        logger.warning("reconcile_provider_keys_read_failed", exc_info=True)
        return {}


def _resolve_litellm_params(raw_params: dict | None, provider_keys: dict[str, str]) -> tuple[dict, bool]:
    params = dict(raw_params or {})
    unresolved = False
    api_key = params.get("api_key")
    if isinstance(api_key, str) and api_key.startswith("os.environ/"):
        key_name = api_key.split("/", 1)[1].strip()
        resolved = (provider_keys.get(key_name) or "").strip()
        if resolved:
            params["api_key"] = resolved
        else:
            unresolved = True
            logger.warning("reconcile_missing_provider_key")
    return params, unresolved


async def _delete_routes(served_name: str, routes: list[dict]) -> tuple[bool, int]:
    deleted = 0
    ok = True
    for r in routes:
        rid = r.get("id", "")
        if not rid:
            continue
        removed = await litellm_client.delete_model(rid)
        if removed:
            deleted += 1
        else:
            ok = False
            logger.warning("reconcile_remove_failed model=%s id=%s", served_name, rid)
    return ok, deleted


async def _push_active_route(
    row: ModelDeployment,
    existing_routes: list[dict],
    provider_keys: dict[str, str],
    maps: ProviderGovernanceMaps,
) -> tuple[str, bool, int]:
    """Sync one active deployment to LiteLLM.

    Returns (action, success, removed_count) where action is unchanged|added|updated|error|skip_no_model.
    """
    served_name = row.served_name
    computed = resolve_deployment_routing_for_deployment(row, maps).litellm_params
    params, unresolved_key = _resolve_litellm_params(computed, provider_keys)
    if not params.get("model"):
        logger.warning("reconcile_skip_no_model served=%s", served_name)
        return "skip_no_model", False, 0
    if unresolved_key:
        await _update_litellm_model_id(row.id, None, "error")
        return "error", False, 0

    mi = {"synesis_deployment_id": row.id, "source": row.source}
    removed_count = 0

    canonical = None
    for r in existing_routes:
        if r.get("deployment_id") == row.id:
            canonical = r
            break

    if canonical:
        got_params = (canonical.get("raw") or {}).get("litellm_params") or {}
        keep_id = canonical.get("id", "")
        if not _litellm_routing_differ(params, got_params):
            dupes = [r for r in existing_routes if r.get("id") and r.get("id") != keep_id]
            if dupes:
                ok, removed = await _delete_routes(served_name, dupes)
                removed_count += removed
                if not ok:
                    await _update_litellm_model_id(row.id, keep_id or None, "active")
                    return "error", False, removed_count
                await _update_litellm_model_id(row.id, keep_id or None, "active")
                return "updated", True, removed_count
            if keep_id:
                await _update_litellm_model_id(row.id, keep_id, "active")
            return "unchanged", True, 0

    had_existing = bool(existing_routes)
    if had_existing:
        ok, removed = await _delete_routes(served_name, existing_routes)
        removed_count += removed
        if not ok:
            return "error", False, removed_count

    result = await litellm_client.add_model(
        model_name=served_name,
        litellm_params=params,
        model_info=mi,
    )
    if result:
        model_id = result.get("model_info", {}).get("id", "")
        await _update_litellm_model_id(row.id, model_id, "active")
        return ("updated" if had_existing else "added"), True, removed_count

    await _update_litellm_model_id(row.id, None, "error")
    logger.warning("reconcile_add_failed served=%s", served_name)
    return "error", False, removed_count


async def reconcile() -> dict:
    """Full reconciliation: compare DB active deployments vs LiteLLM routes, sync differences.

    Returns a summary dict with counts of added/removed/unchanged models.
    """
    litellm_models = await litellm_client.list_models()
    litellm_by_name = _index_litellm_by_name(litellm_models)
    provider_keys = await _load_provider_api_keys()
    maps = await load_provider_governance_maps()

    async with async_session() as session:
        result = await session.execute(select(ModelDeployment).where(ModelDeployment.is_active == True))
        active_rows = list(result.scalars().all())

    db_by_served: dict[str, ModelDeployment] = {}
    for row in active_rows:
        db_by_served[row.served_name] = row

    added = 0
    updated = 0
    removed = 0
    unchanged = 0
    failed = 0
    duplicate_routes_removed = 0

    for served_name, row in db_by_served.items():
        if served_name in PROTECTED_MODELS:
            # Protected routes are intentionally not managed through LiteLLM CRUD.
            # Mark active deployments as active so registry UI does not stay stuck
            # in "activating" forever for Yarn/static aliases.
            if row.status != "active":
                await _update_litellm_model_id(row.id, row.litellm_model_id, "active")
            unchanged += 1
            continue

        existing_routes = litellm_by_name.get(served_name, [])
        action, ok, removed_count = await _push_active_route(row, existing_routes, provider_keys, maps)
        duplicate_routes_removed += removed_count
        if action == "unchanged":
            unchanged += 1
        elif action == "added" and ok:
            added += 1
            logger.info("reconcile_added model=%s served=%s", row.model, served_name)
        elif action == "updated" and ok:
            updated += 1
            logger.info("reconcile_updated model=%s served=%s", row.model, served_name)
        elif action == "error" or not ok:
            failed += 1  # logged in _push_active_route

    for name, routes in litellm_by_name.items():
        if name in PROTECTED_MODELS:
            continue
        if name not in db_by_served:
            ok, removed_count = await _delete_routes(name, routes)
            removed += removed_count
            if ok:
                logger.info("reconcile_removed model=%s", name)
            else:
                failed += 1

    # Push fallback configuration to LiteLLM for active models that have fallbacks defined
    fallback_map: list[dict[str, list[str]]] = []
    for row in active_rows:
        fb = row.fallbacks
        if fb and isinstance(fb, list) and row.served_name not in PROTECTED_MODELS:
            fallback_map.append({row.served_name: fb})
    if fallback_map:
        ok = await litellm_client.set_fallbacks(fallback_map)
        if ok:
            logger.info("reconcile_fallbacks_set count=%d", len(fallback_map))
        else:
            failed += 1
            logger.warning("reconcile_fallbacks_failed")

    summary = {
        "added": added,
        "updated": updated,
        "removed": removed,
        "unchanged": unchanged,
        "failed": failed,
        "duplicate_routes_removed": duplicate_routes_removed,
        "total_active": len(active_rows),
        "fallbacks_configured": len(fallback_map),
    }
    logger.info("reconcile_done %s", summary)
    return summary


async def reconcile_single(deployment_id: int) -> bool:
    """Targeted sync for a single model after activate/deactivate."""
    async with async_session() as session:
        row = await session.get(ModelDeployment, deployment_id)
        if row is None:
            return False

        served_name = row.served_name
        if served_name in PROTECTED_MODELS:
            return True

        if row.is_active:
            litellm_by_name = _index_litellm_by_name(await litellm_client.list_models())
            existing_routes = litellm_by_name.get(served_name, [])
            provider_keys = await _load_provider_api_keys()
            maps = await load_provider_governance_maps()
            action, ok, _removed = await _push_active_route(row, existing_routes, provider_keys, maps)
            return ok and action != "skip_no_model"
        else:
            litellm_by_name = _index_litellm_by_name(await litellm_client.list_models())
            existing_routes = litellm_by_name.get(served_name, [])
            if existing_routes:
                await _delete_routes(served_name, existing_routes)
            elif row.litellm_model_id:
                await litellm_client.delete_model(row.litellm_model_id)
            await _update_litellm_model_id(row.id, None, "configured")
            return True


async def _update_litellm_model_id(deployment_id: int, model_id: str | None, status: str) -> None:
    async with async_session() as session:
        row = await session.get(ModelDeployment, deployment_id)
        if row:
            row.litellm_model_id = model_id
            row.status = status
            await session.commit()
