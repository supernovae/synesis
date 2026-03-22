"""Reconciler: syncs active model_deployments in DB to LiteLLM proxy via management API."""

from __future__ import annotations

import logging

from sqlalchemy import select

from ..db.engine import async_session
from ..db.models import ModelDeployment
from . import litellm_client

logger = logging.getLogger("synesis.admin.model_reconciler")

# LiteLLM routes defined in base/gateway/litellm-config.yaml but not represented as
# admin ModelDeployment rows (KNOWN_ROLES). Reconcile must not DELETE these via API —
# config-backed routes return 500 on /model/delete and should stay for Open WebUI / Yarn.
PROTECTED_MODELS = frozenset({"synesis-agent", "synesis-thinking", "synesis-yarn"})

# Compared to detect routing drift (/model/info omits redacted secrets — omit api_key).
_ROUTING_KEYS = ("model", "api_base", "max_tokens", "temperature")


def _litellm_routing_differ(wanted: dict | None, got: dict | None) -> bool:
    if not wanted or not wanted.get("model"):
        return False
    g = got or {}
    for k in _ROUTING_KEYS:
        if wanted.get(k) != g.get(k):
            return True
    return False


def _index_litellm_by_name(litellm_models: list[dict]) -> dict[str, dict]:
    by_name: dict[str, dict] = {}
    for m in litellm_models:
        name = m.get("model_name", "")
        mid = m.get("model_info", {}).get("id", "")
        if name:
            by_name[name] = {"id": mid, "raw": m}
    return by_name


async def _push_active_route(row: ModelDeployment, existing: dict | None) -> tuple[str, bool]:
    """Sync one active deployment to LiteLLM.

    Returns (action, success) where action is unchanged|added|updated|error|skip_no_model.
    """
    served_name = row.served_name
    params = dict(row.litellm_params) if row.litellm_params else {}
    if not params.get("model"):
        logger.warning("reconcile_skip_no_model served=%s", served_name)
        return "skip_no_model", False

    mi = {"synesis_deployment_id": row.id, "source": row.source}

    if existing:
        got_params = (existing.get("raw") or {}).get("litellm_params") or {}
        if not _litellm_routing_differ(params, got_params):
            eid = existing.get("id", "")
            if eid:
                await _update_litellm_model_id(row.id, eid, "active")
            return "unchanged", True

        eid = existing.get("id", "")
        if eid:
            deleted = await litellm_client.delete_model(eid)
            if not deleted:
                logger.warning(
                    "reconcile_param_drift_delete_failed served=%s "
                    "(config-backed model? remove from litellm ConfigMap or enable DB routes)",
                    served_name,
                )
                return "error", False

    result = await litellm_client.add_model(
        model_name=served_name,
        litellm_params=params,
        model_info=mi,
    )
    if result:
        model_id = result.get("model_info", {}).get("id", "")
        await _update_litellm_model_id(row.id, model_id, "active")
        return ("updated" if existing else "added"), True

    await _update_litellm_model_id(row.id, None, "error")
    logger.warning("reconcile_add_failed served=%s", served_name)
    return "error", False


async def reconcile() -> dict:
    """Full reconciliation: compare DB active deployments vs LiteLLM routes, sync differences.

    Returns a summary dict with counts of added/removed/unchanged models.
    """
    litellm_models = await litellm_client.list_models()
    litellm_by_name = _index_litellm_by_name(litellm_models)

    async with async_session() as session:
        result = await session.execute(
            select(ModelDeployment).where(ModelDeployment.is_active == True)  # noqa: E712
        )
        active_rows = list(result.scalars().all())

    db_by_served: dict[str, ModelDeployment] = {}
    for row in active_rows:
        db_by_served[row.served_name] = row

    added = 0
    updated = 0
    removed = 0
    unchanged = 0
    failed = 0

    for served_name, row in db_by_served.items():
        if served_name in PROTECTED_MODELS:
            unchanged += 1
            continue

        existing = litellm_by_name.get(served_name)
        action, ok = await _push_active_route(row, existing)
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

    for name, info in litellm_by_name.items():
        if name in PROTECTED_MODELS:
            continue
        if name not in db_by_served and info["id"]:
            ok = await litellm_client.delete_model(info["id"])
            if ok:
                removed += 1
                logger.info("reconcile_removed model=%s", name)
            else:
                failed += 1
                logger.warning("reconcile_remove_failed model=%s", name)

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
            existing = litellm_by_name.get(served_name)
            action, ok = await _push_active_route(row, existing)
            return ok and action != "skip_no_model"
        else:
            if row.litellm_model_id:
                await litellm_client.delete_model(row.litellm_model_id)
            await _update_litellm_model_id(row.id, None, "configured")
            return True


async def _update_litellm_model_id(
    deployment_id: int, model_id: str | None, status: str
) -> None:
    async with async_session() as session:
        row = await session.get(ModelDeployment, deployment_id)
        if row:
            row.litellm_model_id = model_id
            row.status = status
            await session.commit()
