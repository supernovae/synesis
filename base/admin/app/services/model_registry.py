"""Read models.yaml, LiteLLM config, and Postgres overrides for model registry and costs."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import select

from ..db.engine import async_session
from ..db.models import ModelCost as ModelCostRow
from ..deps import MODELS_YAML_PATH

logger = logging.getLogger("synesis.admin.models")

_cache: dict[str, Any] | None = None


def _load_models_yaml() -> dict[str, Any]:
    global _cache
    if _cache is not None:
        return _cache
    p = Path(MODELS_YAML_PATH)
    if not p.exists():
        logger.info("models_yaml_not_found path=%s", p)
        return {}
    try:
        with open(p) as f:
            _cache = yaml.safe_load(f) or {}
        return _cache
    except Exception as exc:
        logger.warning("models_yaml_error error=%s", str(exc)[:80])
        return {}


def get_model_registry() -> list[dict]:
    data = _load_models_yaml()
    roles = data.get("roles", {})
    models = []
    for role_name, role_cfg in roles.items():
        models.append(
            {
                "role": role_name,
                "model_name": role_cfg.get("default_model", ""),
                "served_name": role_cfg.get("served_model_name", role_name),
                "endpoint": f"http://{role_cfg.get('service_name', role_name)}.{role_cfg.get('namespace', 'synesis-models')}.svc.cluster.local:8080/v1",
                "status": "healthy",
                "description": role_cfg.get("description", ""),
            }
        )
    return models


def _parse_dollar_rates(notes: str) -> tuple[float, float]:
    """Extract $/M rates from notes text like '$0.20/M in, $0.50/M out'."""
    input_cost = 0.0
    output_cost = 0.0
    if "$" not in notes or "/M" not in notes:
        return input_cost, output_cost
    try:
        parts = notes.split("$")
        for part in parts[1:]:
            val = part.split("/M")[0].strip()
            cleaned = re.sub(r"[^0-9.]", "", val)
            if not cleaned:
                continue
            num = float(cleaned)
            if input_cost == 0:
                input_cost = num
            else:
                output_cost = num
    except (ValueError, IndexError):
        pass
    return input_cost, output_cost


def get_cost_estimates_from_yaml() -> list[dict]:
    """Parse both local profiles and openrouter_profiles from models.yaml."""
    data = _load_models_yaml()
    costs = []

    for profile_name, profile_cfg in data.get("profiles", {}).items():
        assignments = profile_cfg.get("assignments", {})
        cost_estimate = profile_cfg.get("cost_estimate", {})
        for role, assignment in assignments.items():
            model = assignment.get("model_override", "")
            notes = assignment.get("notes", "")
            input_cost, output_cost = _parse_dollar_rates(notes)
            costs.append(
                {
                    "role": role,
                    "model": model,
                    "profile": profile_name,
                    "source": "local",
                    "input_per_million": input_cost,
                    "output_per_million": output_cost,
                    "monthly_fixed_cost": 0.0,
                    "cost_formula": cost_estimate.get("on_demand", ""),
                    "notes": notes,
                }
            )

    for profile_name, profile_cfg in data.get("openrouter_profiles", {}).items():
        assignments = profile_cfg.get("assignments", {})
        for role, assignment in assignments.items():
            model = assignment.get("openrouter_model", "")
            notes = assignment.get("notes", "")
            input_cost, output_cost = _parse_dollar_rates(notes)
            costs.append(
                {
                    "role": role,
                    "model": model,
                    "profile": f"openrouter-{profile_name}",
                    "source": "openrouter",
                    "input_per_million": input_cost,
                    "output_per_million": output_cost,
                    "monthly_fixed_cost": 0.0,
                    "cost_formula": "",
                    "notes": notes,
                }
            )

    return costs


async def get_cost_estimates() -> list[dict]:
    """Return cost data: Postgres overrides merged with models.yaml baseline."""
    yaml_costs = get_cost_estimates_from_yaml()

    try:
        async with async_session() as session:
            result = await session.execute(select(ModelCostRow))
            db_rows = result.scalars().all()
    except Exception:
        logger.debug("model_costs_db_read_failed", exc_info=True)
        db_rows = []

    db_lookup: dict[tuple[str, str], ModelCostRow] = {}
    for row in db_rows:
        db_lookup[(row.role, row.profile)] = row

    merged = []
    for cost in yaml_costs:
        key = (cost["role"], cost["profile"])
        if key in db_lookup:
            row = db_lookup.pop(key)
            merged.append(
                {
                    "role": row.role,
                    "model": row.model,
                    "profile": row.profile,
                    "source": row.source,
                    "input_per_million": row.input_per_million,
                    "output_per_million": row.output_per_million,
                    "monthly_fixed_cost": row.monthly_fixed_cost,
                    "cost_formula": row.cost_formula,
                    "notes": row.notes,
                }
            )
        else:
            merged.append(cost)

    for row in db_lookup.values():
        merged.append(
            {
                "role": row.role,
                "model": row.model,
                "profile": row.profile,
                "source": row.source,
                "input_per_million": row.input_per_million,
                "output_per_million": row.output_per_million,
                "monthly_fixed_cost": row.monthly_fixed_cost,
                "cost_formula": row.cost_formula,
                "notes": row.notes,
            }
        )

    return merged


async def upsert_model_cost(data: dict) -> dict:
    """Create or update a model cost entry in Postgres."""
    async with async_session() as session:
        q = select(ModelCostRow).where(
            ModelCostRow.role == data["role"],
            ModelCostRow.profile == data.get("profile", ""),
        )
        result = await session.execute(q)
        row = result.scalar_one_or_none()

        if row is None:
            row = ModelCostRow(
                role=data["role"],
                model=data.get("model", ""),
                profile=data.get("profile", ""),
            )
            session.add(row)

        row.source = data.get("source", row.source or "local")
        row.input_per_million = data.get("input_per_million", row.input_per_million)
        row.output_per_million = data.get("output_per_million", row.output_per_million)
        row.monthly_fixed_cost = data.get("monthly_fixed_cost", row.monthly_fixed_cost)
        row.cost_formula = data.get("cost_formula", row.cost_formula)
        row.notes = data.get("notes", row.notes)
        row.model = data.get("model", row.model)

        await session.commit()
        await session.refresh(row)
        return {
            "id": row.id,
            "role": row.role,
            "model": row.model,
            "profile": row.profile,
            "source": row.source,
            "input_per_million": row.input_per_million,
            "output_per_million": row.output_per_million,
            "monthly_fixed_cost": row.monthly_fixed_cost,
            "cost_formula": row.cost_formula,
            "notes": row.notes,
        }


async def get_model_topology() -> dict:
    """Build a topology view: per-environment x role with model, endpoint, status."""
    data = _load_models_yaml()
    roles = data.get("roles", {})
    profiles = data.get("profiles", {})
    openrouter_profiles = data.get("openrouter_profiles", {})

    environments: dict[str, list[dict]] = {}

    for profile_name, profile_cfg in profiles.items():
        env_name = f"local-{profile_name}"
        env_entries = []
        assignments = profile_cfg.get("assignments", {})
        for role_name in roles:
            assignment = assignments.get(role_name, {})
            model = assignment.get("model_override", roles[role_name].get("default_model", ""))
            service_name = roles[role_name].get("service_name", role_name)
            namespace = roles[role_name].get("namespace", "synesis-models")
            endpoint = f"http://{service_name}.{namespace}.svc.cluster.local:8080/v1"
            env_entries.append({
                "role": role_name,
                "model": model,
                "served_name": assignment.get("served_model_name", roles[role_name].get("served_model_name", role_name)),
                "endpoint": endpoint,
                "status": "configured",
                "gpu": assignment.get("gpu", ""),
                "notes": assignment.get("notes", ""),
            })
        environments[env_name] = env_entries

    for profile_name, profile_cfg in openrouter_profiles.items():
        env_name = f"openrouter-{profile_name}"
        env_entries = []
        assignments = profile_cfg.get("assignments", {})
        for role_name, assignment in assignments.items():
            env_entries.append({
                "role": role_name,
                "model": assignment.get("openrouter_model", ""),
                "served_name": role_name,
                "endpoint": "https://openrouter.ai/api/v1",
                "status": "configured",
                "gpu": "",
                "notes": assignment.get("notes", ""),
            })
        environments[env_name] = env_entries

    try:
        async with async_session() as session:
            from ..db.models import ModelDeployment

            result = await session.execute(select(ModelDeployment))
            db_rows = result.scalars().all()
            for row in db_rows:
                env = row.environment
                if env not in environments:
                    environments[env] = []
                existing = next(
                    (e for e in environments[env] if e["role"] == row.role), None
                )
                if existing:
                    existing["status"] = row.status
                    existing["model"] = row.model or existing["model"]
                    existing["endpoint"] = row.endpoint or existing["endpoint"]
                else:
                    environments[env].append({
                        "role": row.role,
                        "model": row.model,
                        "served_name": row.served_name,
                        "endpoint": row.endpoint,
                        "status": row.status,
                        "gpu": "",
                        "notes": "",
                    })
    except Exception:
        logger.debug("model_topology_db_merge_failed", exc_info=True)

    return {"environments": environments, "roles": list(roles.keys())}


async def get_cost_by_model() -> list[dict]:
    """Compute total cost per model from traces in Postgres."""
    from ..db.models import Trace

    async with async_session() as session:
        try:
            cutoff_7d = __import__("time").time() - 7 * 86400

            q = select(Trace).where(Trace.timestamp >= cutoff_7d)
            result = await session.execute(q)
            rows = result.scalars().all()

            model_agg: dict[str, dict] = {}
            for row in rows:
                full = row.full_record or {}
                for span in full.get("spans", []):
                    for call in span.get("llm_calls", []):
                        model = call.get("model", "unknown")
                        if model not in model_agg:
                            model_agg[model] = {
                                "model": model,
                                "prompt_tokens": 0,
                                "completion_tokens": 0,
                                "total_tokens": 0,
                                "requests": 0,
                                "cost_usd": 0.0,
                            }
                        agg = model_agg[model]
                        agg["prompt_tokens"] += call.get("prompt_tokens", 0)
                        agg["completion_tokens"] += call.get("completion_tokens", 0)
                        agg["total_tokens"] += call.get("total_tokens", 0)
                        agg["requests"] += 1

            costs = await get_cost_estimates()
            pricing: dict[str, tuple[float, float]] = {}
            for c in costs:
                served = c.get("model", "")
                if served:
                    pricing[served] = (c["input_per_million"], c["output_per_million"])
                role = c.get("role", "")
                served_name = f"synesis-{role}"
                if served_name not in pricing:
                    pricing[served_name] = (c["input_per_million"], c["output_per_million"])

            for model, agg in model_agg.items():
                rates = pricing.get(model, (0, 0))
                if rates == (0, 0):
                    for key in pricing:
                        if key in model or model in key:
                            rates = pricing[key]
                            break
                agg["cost_usd"] = round(
                    (agg["prompt_tokens"] / 1_000_000) * rates[0] + (agg["completion_tokens"] / 1_000_000) * rates[1],
                    6,
                )

            return sorted(model_agg.values(), key=lambda x: x["cost_usd"], reverse=True)
        except Exception:
            logger.warning("cost_by_model_failed", exc_info=True)
            return []
