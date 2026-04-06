"""Background script to reconcile actual costs with vendor APIs (OpenRouter, DeepInfra).

This script queries vendor APIs using request_id or trace_id to fetch the exact billed cost,
and updates actual_cost_usd in traces, planner_usage_log, and yarn_usage_log.
"""

import asyncio
import logging
import os
from datetime import UTC, datetime, timedelta
from typing import Any

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


async def reconcile_costs(since_hours: int = 24) -> None:
    """Reconcile costs for traces and usage logs created in the last `since_hours`."""
    cutoff = datetime.now(UTC) - timedelta(hours=since_hours)
    
    openrouter_key = os.environ.get("OPENROUTER_API_KEY")
    deepinfra_key = os.environ.get("DEEPINFRA_API_KEY")
    
    if not openrouter_key and not deepinfra_key:
        logger.warning("No vendor API keys found. Skipping reconciliation.")
        return

    async with httpx.AsyncClient(timeout=10.0) as client:
        async with async_session() as session:
            # 1. Reconcile YarnUsageLog
            logger.info("Reconciling YarnUsageLog...")
            q_yarn = select(YarnUsageLog).where(
                YarnUsageLog.created_at >= cutoff,
                YarnUsageLog.pricing_source != "provider"  # Only reconcile if we don't have provider cost
            )
            yarn_logs = (await session.execute(q_yarn)).scalars().all()
            
            for log in yarn_logs:
                cost = None
                if log.provider == "openrouter" and openrouter_key:
                    cost = await fetch_openrouter_cost(client, log.request_id, openrouter_key)
                elif log.provider == "deepinfra" and deepinfra_key:
                    cost = await fetch_deepinfra_cost(client, log.request_id, deepinfra_key)
                
                if cost is not None:
                    await session.execute(
                        update(YarnUsageLog)
                        .where(YarnUsageLog.id == log.id)
                        .values(actual_cost_usd=cost, pricing_source="provider_reconciled")
                    )
            
            # 2. Reconcile PlannerUsageLog
            logger.info("Reconciling PlannerUsageLog...")
            q_planner = select(PlannerUsageLog).where(
                PlannerUsageLog.created_at >= cutoff,
                PlannerUsageLog.pricing_source != "provider"
            )
            planner_logs = (await session.execute(q_planner)).scalars().all()
            
            for log in planner_logs:
                cost = None
                # Assuming model string might contain provider info, or we check both
                if "openrouter" in log.model.lower() and openrouter_key:
                    cost = await fetch_openrouter_cost(client, log.request_id, openrouter_key)
                elif "deepinfra" in log.model.lower() and deepinfra_key:
                    cost = await fetch_deepinfra_cost(client, log.request_id, deepinfra_key)
                
                if cost is not None:
                    await session.execute(
                        update(PlannerUsageLog)
                        .where(PlannerUsageLog.id == log.id)
                        .values(actual_cost_usd=cost, pricing_source="provider_reconciled")
                    )
            
            # 3. Reconcile Traces
            logger.info("Reconciling Traces...")
            # For traces, we might need to look at the full_record to determine provider
            # This is a simplified approach updating the top-level actual_cost_usd
            q_trace = select(Trace).where(
                Trace.created_at >= cutoff,
                Trace.actual_cost_usd == 0.0,
                Trace.estimated_cost_usd > 0.0
            )
            traces = (await session.execute(q_trace)).scalars().all()
            
            for trace in traces:
                cost = None
                model = trace.full_record.get("model", "").lower()
                if "openrouter" in model and openrouter_key:
                    cost = await fetch_openrouter_cost(client, trace.trace_id, openrouter_key)
                elif "deepinfra" in model and deepinfra_key:
                    cost = await fetch_deepinfra_cost(client, trace.trace_id, deepinfra_key)
                
                if cost is not None:
                    # Update top-level actual_cost_usd
                    await session.execute(
                        update(Trace)
                        .where(Trace.id == trace.id)
                        .values(actual_cost_usd=cost)
                    )
            
            await session.commit()
            logger.info("Reconciliation complete.")


if __name__ == "__main__":
    asyncio.run(reconcile_costs())
