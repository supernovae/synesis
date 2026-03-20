"""Cost estimation from registry-aligned get_cost_estimates (Postgres)."""

from __future__ import annotations

from .model_registry import get_cost_estimates


async def get_cost_summary() -> dict:
    costs = await get_cost_estimates()
    total = sum(c.get("monthly_fixed_cost", 0) for c in costs)
    by_role: dict[str, float] = {}
    for c in costs:
        role = c.get("role", "unknown")
        by_role[role] = by_role.get(role, 0) + c.get("monthly_fixed_cost", 0)
    return {
        "period": "monthly estimate",
        "total_usd": total,
        "by_role": by_role,
    }
