"""Model registry: seed from models.yaml, DB-first CRUD, cost estimates, topology."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import delete, func, select

from ..db.engine import async_session
from ..db.models import CostRateSnapshot, ModelCost as ModelCostRow, ModelDeployment
from ..deps import MODELS_YAML_PATH

logger = logging.getLogger("synesis.admin.models")

_yaml_cache: dict[str, Any] | None = None


def _load_models_yaml() -> dict[str, Any]:
    global _yaml_cache
    if _yaml_cache is not None:
        return _yaml_cache
    p = Path(MODELS_YAML_PATH)
    if not p.exists():
        logger.info("models_yaml_not_found path=%s", p)
        return {}
    try:
        with open(p) as f:
            _yaml_cache = yaml.safe_load(f) or {}
        return _yaml_cache
    except Exception as exc:
        logger.warning("models_yaml_error error=%s", str(exc)[:80])
        return {}


def invalidate_yaml_cache() -> None:
    global _yaml_cache
    _yaml_cache = None


# ---------------------------------------------------------------------------
# Seed model_deployments from models.yaml (bootstrap-only)
# ---------------------------------------------------------------------------

async def seed_model_deployments(*, force: bool = False) -> int:
    """Parse models.yaml and populate model_deployments if the table is empty.

    Returns the number of rows inserted.  When force=True, existing rows are
    deleted first so the unique constraint is not violated.
    """
    data = _load_models_yaml()
    if not data:
        logger.info("seed_models_skip reason=no_yaml")
        return 0

    is_first_seed = False

    async with async_session() as session:
        count = (await session.execute(select(func.count(ModelDeployment.id)))).scalar() or 0
        if not force and count > 0:
            logger.info("seed_models_skip reason=table_not_empty count=%d", count)
            return 0

        is_first_seed = count == 0

        if force and count > 0:
            await session.execute(delete(ModelDeployment))
            logger.info("seed_models_cleared existing=%d", count)

        roles = data.get("roles", {})
        inserted = 0
        first_openrouter_env: str = ""

        for profile_name, profile_cfg in data.get("profiles", {}).items():
            env_name = f"local-{profile_name}"
            assignments = profile_cfg.get("assignments", {})
            for role_name, assignment in assignments.items():
                role_def = roles.get(role_name, {})
                model = assignment.get("model_override", role_def.get("default_model", ""))
                served_name = role_def.get("served_model_name", role_name)
                service_name = role_def.get("service_name", role_name)
                namespace = role_def.get("namespace", "synesis-models")
                endpoint = f"http://{service_name}.{namespace}.svc.cluster.local:8080/v1"
                notes_text = assignment.get("notes", "")

                litellm_params = {
                    "model": f"openai/{served_name}",
                    "api_base": endpoint,
                    "api_key": "not-needed",
                    "max_tokens": 32768,
                    "temperature": 0.2,
                }

                row = ModelDeployment(
                    environment=env_name,
                    role=role_name,
                    model=model,
                    endpoint=endpoint,
                    served_name=served_name,
                    status="configured",
                    profile=profile_name,
                    source="vllm",
                    litellm_params=litellm_params,
                    is_active=False,
                    description=role_def.get("description", ""),
                    notes=notes_text.strip() if notes_text else "",
                    gpu_config={"gpu": assignment.get("gpu", ""), "tp": assignment.get("tp", 1)},
                )
                session.add(row)
                inserted += 1

        for profile_name, profile_cfg in data.get("openrouter_profiles", {}).items():
            env_name = f"openrouter-{profile_name}"
            if not first_openrouter_env:
                first_openrouter_env = env_name
            assignments = profile_cfg.get("assignments", {})
            for role_name, assignment in assignments.items():
                role_def = roles.get(role_name, {})
                or_model = assignment.get("openrouter_model", "")
                served_name = role_def.get("served_model_name", f"synesis-{role_name}")
                notes_text = assignment.get("notes", "")

                litellm_params = {
                    "model": f"openrouter/{or_model}",
                    "api_key": "os.environ/OPENROUTER_API_KEY",
                    "max_tokens": 8192,
                    "temperature": 0.1,
                }

                activate = is_first_seed and env_name == first_openrouter_env

                row = ModelDeployment(
                    environment=env_name,
                    role=role_name,
                    model=or_model,
                    endpoint="https://openrouter.ai/api/v1",
                    served_name=served_name,
                    status="activating" if activate else "configured",
                    profile=profile_name,
                    source="openrouter",
                    litellm_params=litellm_params,
                    is_active=activate,
                    description=role_def.get("description", ""),
                    notes=notes_text.strip() if notes_text else "",
                )
                session.add(row)
                inserted += 1

        await session.commit()
        logger.info(
            "seed_models_done inserted=%d auto_activated=%s",
            inserted,
            first_openrouter_env if is_first_seed else "none",
        )
        return inserted


# ---------------------------------------------------------------------------
# DB-first model registry queries
# ---------------------------------------------------------------------------

async def get_model_deployments() -> list[dict]:
    """Return all model deployments from DB."""
    async with async_session() as session:
        result = await session.execute(
            select(ModelDeployment).order_by(ModelDeployment.environment, ModelDeployment.role)
        )
        rows = result.scalars().all()
        return [_deployment_to_dict(r) for r in rows]


async def get_active_deployments() -> list[ModelDeployment]:
    """Return ORM rows for all active deployments."""
    async with async_session() as session:
        result = await session.execute(
            select(ModelDeployment).where(ModelDeployment.is_active == True)  # noqa: E712
        )
        return list(result.scalars().all())


async def get_deployment_by_id(deployment_id: int) -> ModelDeployment | None:
    async with async_session() as session:
        return await session.get(ModelDeployment, deployment_id)


async def create_deployment(data: dict) -> dict:
    async with async_session() as session:
        row = ModelDeployment(
            environment=data["environment"],
            role=data["role"],
            model=data.get("model", ""),
            endpoint=data.get("endpoint", ""),
            served_name=data.get("served_name", f"synesis-{data['role']}"),
            status="configured",
            profile=data.get("profile", ""),
            source=data.get("source", "local"),
            litellm_params=data.get("litellm_params"),
            is_active=data.get("is_active", False),
            description=data.get("description", ""),
            notes=data.get("notes", ""),
            gpu_config=data.get("gpu_config"),
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return _deployment_to_dict(row)


async def update_deployment(deployment_id: int, data: dict) -> dict | None:
    async with async_session() as session:
        row = await session.get(ModelDeployment, deployment_id)
        if row is None:
            return None
        for field in (
            "model", "endpoint", "served_name", "status", "profile",
            "source", "litellm_params", "is_active", "description",
            "notes", "gpu_config", "environment", "role", "fallbacks",
        ):
            if field in data:
                setattr(row, field, data[field])
        await session.commit()
        await session.refresh(row)
        return _deployment_to_dict(row)


async def delete_deployment(deployment_id: int) -> bool:
    async with async_session() as session:
        row = await session.get(ModelDeployment, deployment_id)
        if row is None:
            return False
        await session.delete(row)
        await session.commit()
        return True


async def set_deployment_active(deployment_id: int, active: bool) -> dict | None:
    async with async_session() as session:
        row = await session.get(ModelDeployment, deployment_id)
        if row is None:
            return None
        row.is_active = active
        if active:
            row.status = "activating"
        else:
            row.status = "configured"
            row.litellm_model_id = None
        await session.commit()
        await session.refresh(row)
        return _deployment_to_dict(row)


async def activate_environment(environment: str) -> list[dict]:
    """Activate all deployments in a given environment, deactivate all others."""
    async with async_session() as session:
        result = await session.execute(select(ModelDeployment))
        rows = result.scalars().all()
        updated = []
        for row in rows:
            was_active = row.is_active
            row.is_active = row.environment == environment
            if row.is_active and not was_active:
                row.status = "activating"
            elif not row.is_active and was_active:
                row.status = "configured"
                row.litellm_model_id = None
            updated.append(_deployment_to_dict(row))
        await session.commit()
        return updated


def _deployment_to_dict(row: ModelDeployment) -> dict:
    return {
        "id": row.id,
        "environment": row.environment,
        "role": row.role,
        "model": row.model,
        "endpoint": row.endpoint,
        "served_name": row.served_name,
        "status": row.status,
        "profile": row.profile,
        "source": row.source,
        "litellm_params": row.litellm_params,
        "is_active": row.is_active,
        "description": row.description,
        "notes": row.notes,
        "gpu_config": row.gpu_config,
        "litellm_model_id": row.litellm_model_id,
        "fallbacks": row.fallbacks,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


# ---------------------------------------------------------------------------
# Legacy: YAML-based model registry (kept for backward compat of GET /models)
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Topology (DB-first, falls back to YAML for display)
# ---------------------------------------------------------------------------

async def get_model_topology() -> dict:
    """Build topology from DB deployments, grouped by environment."""
    deployments = await get_model_deployments()
    environments: dict[str, list[dict]] = {}

    for d in deployments:
        env = d["environment"]
        if env not in environments:
            environments[env] = []
        environments[env].append({
            "id": d["id"],
            "role": d["role"],
            "model": d["model"],
            "served_name": d["served_name"],
            "endpoint": d["endpoint"],
            "status": d["status"],
            "source": d["source"],
            "is_active": d["is_active"],
            "gpu": d.get("gpu_config", {}).get("gpu", "") if d.get("gpu_config") else "",
            "notes": d["notes"],
        })

    if not environments:
        return _topology_from_yaml()

    data = _load_models_yaml()
    return {"environments": environments, "roles": list(data.get("roles", {}).keys())}


def _topology_from_yaml() -> dict:
    """Fallback topology from YAML if DB is empty."""
    data = _load_models_yaml()
    roles = data.get("roles", {})
    profiles = data.get("profiles", {})
    openrouter_profiles = data.get("openrouter_profiles", {})
    environments: dict[str, list[dict]] = {}

    for profile_name, profile_cfg in profiles.items():
        env_name = f"local-{profile_name}"
        entries = []
        for role_name in roles:
            assignment = profile_cfg.get("assignments", {}).get(role_name, {})
            model = assignment.get("model_override", roles[role_name].get("default_model", ""))
            service_name = roles[role_name].get("service_name", role_name)
            namespace = roles[role_name].get("namespace", "synesis-models")
            entries.append({
                "role": role_name,
                "model": model,
                "served_name": roles[role_name].get("served_model_name", role_name),
                "endpoint": f"http://{service_name}.{namespace}.svc.cluster.local:8080/v1",
                "status": "configured",
                "source": "vllm",
                "is_active": False,
                "gpu": assignment.get("gpu", ""),
                "notes": assignment.get("notes", ""),
            })
        environments[env_name] = entries

    for profile_name, profile_cfg in openrouter_profiles.items():
        env_name = f"openrouter-{profile_name}"
        entries = []
        for role_name, assignment in profile_cfg.get("assignments", {}).items():
            entries.append({
                "role": role_name,
                "model": assignment.get("openrouter_model", ""),
                "served_name": role_name,
                "endpoint": "https://openrouter.ai/api/v1",
                "status": "configured",
                "source": "openrouter",
                "is_active": False,
                "gpu": "",
                "notes": assignment.get("notes", ""),
            })
        environments[env_name] = entries

    return {"environments": environments, "roles": list(roles.keys())}


# ---------------------------------------------------------------------------
# Cost estimates (unchanged logic, YAML + DB merge)
# ---------------------------------------------------------------------------

def _parse_dollar_rates(notes: str) -> tuple[float, float]:
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
    data = _load_models_yaml()
    costs = []

    for profile_name, profile_cfg in data.get("profiles", {}).items():
        assignments = profile_cfg.get("assignments", {})
        cost_estimate = profile_cfg.get("cost_estimate", {})
        for role, assignment in assignments.items():
            model = assignment.get("model_override", "")
            notes = assignment.get("notes", "")
            input_cost, output_cost = _parse_dollar_rates(notes)
            costs.append({
                "role": role, "model": model, "profile": profile_name,
                "source": "local", "input_per_million": input_cost,
                "output_per_million": output_cost, "monthly_fixed_cost": 0.0,
                "cost_formula": cost_estimate.get("on_demand", ""), "notes": notes,
            })

    for profile_name, profile_cfg in data.get("openrouter_profiles", {}).items():
        assignments = profile_cfg.get("assignments", {})
        for role, assignment in assignments.items():
            model = assignment.get("openrouter_model", "")
            notes = assignment.get("notes", "")
            input_cost, output_cost = _parse_dollar_rates(notes)
            costs.append({
                "role": role, "model": model, "profile": f"openrouter-{profile_name}",
                "source": "openrouter", "input_per_million": input_cost,
                "output_per_million": output_cost, "monthly_fixed_cost": 0.0,
                "cost_formula": "", "notes": notes,
            })

    return costs


async def get_cost_estimates() -> list[dict]:
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
            merged.append({
                "role": row.role, "model": row.model, "profile": row.profile,
                "source": row.source, "input_per_million": row.input_per_million,
                "output_per_million": row.output_per_million,
                "monthly_fixed_cost": row.monthly_fixed_cost,
                "cost_formula": row.cost_formula, "notes": row.notes,
            })
        else:
            merged.append(cost)

    for row in db_lookup.values():
        merged.append({
            "role": row.role, "model": row.model, "profile": row.profile,
            "source": row.source, "input_per_million": row.input_per_million,
            "output_per_million": row.output_per_million,
            "monthly_fixed_cost": row.monthly_fixed_cost,
            "cost_formula": row.cost_formula, "notes": row.notes,
        })

    return merged


async def upsert_model_cost(data: dict) -> dict:
    async with async_session() as session:
        q = select(ModelCostRow).where(
            ModelCostRow.role == data["role"],
            ModelCostRow.profile == data.get("profile", ""),
        )
        result = await session.execute(q)
        row = result.scalar_one_or_none()
        if row is None:
            row = ModelCostRow(role=data["role"], model=data.get("model", ""), profile=data.get("profile", ""))
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
            "id": row.id, "role": row.role, "model": row.model,
            "profile": row.profile, "source": row.source,
            "input_per_million": row.input_per_million,
            "output_per_million": row.output_per_million,
            "monthly_fixed_cost": row.monthly_fixed_cost,
            "cost_formula": row.cost_formula, "notes": row.notes,
        }


async def get_cost_by_model() -> list[dict]:
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
                                "model": model, "prompt_tokens": 0,
                                "completion_tokens": 0, "total_tokens": 0,
                                "requests": 0, "cost_usd": 0.0,
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
                    (agg["prompt_tokens"] / 1_000_000) * rates[0]
                    + (agg["completion_tokens"] / 1_000_000) * rates[1],
                    6,
                )

            return sorted(model_agg.values(), key=lambda x: x["cost_usd"], reverse=True)
        except Exception:
            logger.warning("cost_by_model_failed", exc_info=True)
            return []


# ---------------------------------------------------------------------------
# Cost rate snapshots — detect and record pricing changes
# ---------------------------------------------------------------------------

async def capture_cost_rate_snapshots() -> int:
    """Compare current model_costs rates with the most recent snapshot.

    If rates have changed (or no snapshot exists for a model), write a new row.
    Returns the number of new snapshots created.
    """
    costs = await get_cost_estimates()
    if not costs:
        return 0

    async with async_session() as session:
        # Fetch the latest snapshot per model
        result = await session.execute(
            select(CostRateSnapshot).order_by(CostRateSnapshot.captured_at.desc())
        )
        all_snaps = result.scalars().all()
        latest_by_model: dict[str, CostRateSnapshot] = {}
        for s in all_snaps:
            if s.model not in latest_by_model:
                latest_by_model[s.model] = s

        created = 0
        for cost in costs:
            model = cost.get("model", "")
            if not model:
                continue
            inp = cost.get("input_per_million", 0.0)
            out = cost.get("output_per_million", 0.0)
            if inp == 0 and out == 0:
                continue

            prev = latest_by_model.get(model)
            if prev and prev.input_per_million == inp and prev.output_per_million == out:
                continue

            snap = CostRateSnapshot(
                model=model,
                role=cost.get("role", ""),
                input_per_million=inp,
                output_per_million=out,
                source=cost.get("source", "manual"),
            )
            session.add(snap)
            created += 1

        if created:
            await session.commit()
            logger.info("cost_rate_snapshots_created count=%d", created)
        return created
