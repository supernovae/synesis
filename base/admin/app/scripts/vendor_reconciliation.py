"""Reconcile actual costs with provider APIs (OpenRouter, DeepInfra).

Queries provider APIs using request IDs and updates stored actual_cost_usd values
for Yarn and planner usage logs plus top-level traces.
"""

import logging
import os
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import select, update

from ..db.engine import async_session
from ..db.models import PlannerUsageLog, Trace, YarnUsageLog

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("synesis.admin.vendor_reconciliation")


async def fetch_openrouter_cost(client: httpx.AsyncClient, request_id: str, api_key: str) -> float | None:
    """Fetch exact cost from OpenRouter for a given request ID."""
    try:
        # OpenRouter generations API (example endpoint, adjust based on exact API docs)
        resp = await client.get(
            f"https://openrouter.ai/api/v1/generation?id={request_id}",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        if resp.status_code == 200:
            data = resp.json()
            # Extract cost (assuming data["data"]["cost"] or similar)
            cost = data.get("data", {}).get("cost")
            if cost is not None:
                return float(cost)
    except Exception:
        logger.warning(f"Failed to fetch OpenRouter cost for {request_id}", exc_info=True)
    return None


async def fetch_deepinfra_cost(client: httpx.AsyncClient, request_id: str, api_key: str) -> float | None:
    """Fetch exact cost from DeepInfra for a given request ID."""
    try:
        # DeepInfra usage API (example endpoint, adjust based on exact API docs)
        resp = await client.get(
            f"https://api.deepinfra.com/v1/usage/requests/{request_id}",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        if resp.status_code == 200:
            data = resp.json()
            cost = data.get("cost")
            if cost is not None:
                return float(cost)
    except Exception:
        logger.warning(f"Failed to fetch DeepInfra cost for {request_id}", exc_info=True)
    return None


def _provider_like(value: str | None, provider: str) -> bool:
    v = (value or "").strip().lower()
    return v == provider or v.startswith(f"{provider}/")


async def reconcile_costs(
    since_hours: int = 24,
    provider_keys: dict[str, str] | None = None,
) -> dict[str, int | str]:
    """Reconcile costs for recent traces and usage logs.

    Returns counts of scanned and updated rows by table.
    """
    cutoff = datetime.now(UTC) - timedelta(hours=since_hours)

    provider_keys = provider_keys or {}
    openrouter_key = provider_keys.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
    deepinfra_key = provider_keys.get("DEEPINFRA_API_KEY") or os.environ.get("DEEPINFRA_API_KEY")
    provider_keys_available = int(bool(openrouter_key)) + int(bool(deepinfra_key))

    if not openrouter_key and not deepinfra_key:
        logger.warning("No vendor API keys found. Skipping reconciliation.")
        return {
            "since_hours": since_hours,
            "providers_available": provider_keys_available,
            "yarn_scanned": 0,
            "yarn_updated": 0,
            "planner_scanned": 0,
            "planner_updated": 0,
            "trace_scanned": 0,
            "trace_updated": 0,
        }

    yarn_scanned = 0
    yarn_updated = 0
    planner_scanned = 0
    planner_updated = 0
    trace_scanned = 0
    trace_updated = 0

    async with httpx.AsyncClient(timeout=10.0) as client:
        async with async_session() as session:
            # 1. Reconcile YarnUsageLog
            logger.info("Reconciling YarnUsageLog...")
            q_yarn = select(YarnUsageLog).where(
                YarnUsageLog.created_at >= cutoff,
                YarnUsageLog.pricing_source != "provider",  # Only reconcile if we don't have provider cost
            )
            yarn_logs = (await session.execute(q_yarn)).scalars().all()
            yarn_scanned = len(yarn_logs)

            for log in yarn_logs:
                cost = None
                if _provider_like(log.provider, "openrouter") and openrouter_key:
                    cost = await fetch_openrouter_cost(client, log.request_id, openrouter_key)
                elif _provider_like(log.provider, "deepinfra") and deepinfra_key:
                    cost = await fetch_deepinfra_cost(client, log.request_id, deepinfra_key)

                if cost is not None:
                    await session.execute(
                        update(YarnUsageLog)
                        .where(YarnUsageLog.id == log.id)
                        .values(actual_cost_usd=cost, pricing_source="provider_reconciled")
                    )
                    yarn_updated += 1

            # 2. Reconcile PlannerUsageLog
            logger.info("Reconciling PlannerUsageLog...")
            q_planner = select(PlannerUsageLog).where(
                PlannerUsageLog.created_at >= cutoff,
                PlannerUsageLog.pricing_source != "provider",
            )
            planner_logs = (await session.execute(q_planner)).scalars().all()
            planner_scanned = len(planner_logs)

            for log in planner_logs:
                cost = None
                model_l = (log.model or "").lower()
                if "openrouter" in model_l and openrouter_key:
                    cost = await fetch_openrouter_cost(client, log.request_id, openrouter_key)
                elif "deepinfra" in model_l and deepinfra_key:
                    cost = await fetch_deepinfra_cost(client, log.request_id, deepinfra_key)

                if cost is not None:
                    await session.execute(
                        update(PlannerUsageLog)
                        .where(PlannerUsageLog.id == log.id)
                        .values(actual_cost_usd=cost, pricing_source="provider_reconciled")
                    )
                    planner_updated += 1

            # 3. Reconcile Traces
            logger.info("Reconciling Traces...")
            q_trace = select(Trace).where(
                Trace.created_at >= cutoff,
                Trace.actual_cost_usd == 0.0,
                Trace.estimated_cost_usd > 0.0,
            )
            traces = (await session.execute(q_trace)).scalars().all()
            trace_scanned = len(traces)

            for trace in traces:
                cost = None
                full_record = trace.full_record or {}
                model = str(full_record.get("model", "")).lower()
                if "openrouter" in model and openrouter_key:
                    cost = await fetch_openrouter_cost(client, trace.trace_id, openrouter_key)
                elif "deepinfra" in model and deepinfra_key:
                    cost = await fetch_deepinfra_cost(client, trace.trace_id, deepinfra_key)

                if cost is not None:
                    await session.execute(
                        update(Trace)
                        .where(Trace.id == trace.id)
                        .values(actual_cost_usd=cost)
                    )
                    trace_updated += 1

            await session.commit()
            logger.info("Reconciliation complete.")
            return {
                "since_hours": since_hours,
                "providers_available": provider_keys_available,
                "yarn_scanned": yarn_scanned,
                "yarn_updated": yarn_updated,
                "planner_scanned": planner_scanned,
                "planner_updated": planner_updated,
                "trace_scanned": trace_scanned,
                "trace_updated": trace_updated,
            }


if __name__ == "__main__":
    import asyncio

    asyncio.run(reconcile_costs())
