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


async def reconcile() -> dict:
    """Full reconciliation: compare DB active deployments vs LiteLLM routes, sync differences.

    Returns a summary dict with counts of added/removed/unchanged models.
    """
    litellm_models = await litellm_client.list_models()
    litellm_by_name: dict[str, dict] = {}
    for m in litellm_models:
        name = m.get("model_name", "")
        mid = m.get("model_info", {}).get("id", "")
        if name:
            litellm_by_name[name] = {"id": mid, "raw": m}

    async with async_session() as session:
        result = await session.execute(
            select(ModelDeployment).where(ModelDeployment.is_active == True)  # noqa: E712
        )
        active_rows = list(result.scalars().all())

    db_by_served: dict[str, ModelDeployment] = {}
    for row in active_rows:
        db_by_served[row.served_name] = row

    added = 0
    removed = 0
    unchanged = 0

    for served_name, row in db_by_served.items():
        if served_name in PROTECTED_MODELS:
            unchanged += 1
            continue

        params = dict(row.litellm_params) if row.litellm_params else {}
        if not params.get("model"):
            logger.warning("reconcile_skip_no_model served=%s", served_name)
            continue

        if served_name in litellm_by_name:
            unchanged += 1
            existing = litellm_by_name[served_name]
            if existing["id"]:
                await _update_litellm_model_id(row.id, existing["id"], "active")
        else:
            result = await litellm_client.add_model(
                model_name=served_name,
                litellm_params=params,
                model_info={"synesis_deployment_id": row.id, "source": row.source},
            )
            if result:
                model_id = result.get("model_info", {}).get("id", "")
                await _update_litellm_model_id(row.id, model_id, "active")
                added += 1
                logger.info("reconcile_added model=%s served=%s", row.model, served_name)
            else:
                await _update_litellm_model_id(row.id, None, "error")
                logger.warning("reconcile_add_failed served=%s", served_name)

    for name, info in litellm_by_name.items():
        if name in PROTECTED_MODELS:
            continue
        if name not in db_by_served and info["id"]:
            ok = await litellm_client.delete_model(info["id"])
            if ok:
                removed += 1
                logger.info("reconcile_removed model=%s", name)
            else:
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
            logger.warning("reconcile_fallbacks_failed")

    summary = {
        "added": added,
        "removed": removed,
        "unchanged": unchanged,
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
            params = dict(row.litellm_params) if row.litellm_params else {}
            if not params.get("model"):
                return False
            result = await litellm_client.add_model(
                model_name=served_name,
                litellm_params=params,
                model_info={"synesis_deployment_id": row.id, "source": row.source},
            )
            if result:
                model_id = result.get("model_info", {}).get("id", "")
                await _update_litellm_model_id(row.id, model_id, "active")
                return True
            else:
                await _update_litellm_model_id(row.id, None, "error")
                return False
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
