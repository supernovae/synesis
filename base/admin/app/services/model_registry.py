"""Model registry: role-first CRUD and cost estimates.

Role assignments (``ModelDeployment``) inherit provider identity from
``ProviderConfig`` + static ``provider_catalog`` via
``resolve_deployment_routing_for_deployment``. API responses and runtime routing
both use that resolver so route parameters in the DB cannot silently drift from
provider governance (API key env name, prefix, default base).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, NamedTuple

from sqlalchemy import select

from ..db.engine import async_session
from ..db.models import ModelCost as ModelCostRow
from ..db.models import ModelDeployment, ModelRoleHistory, ProviderConfig
from .provider_catalog import (
    KNOWN_ROLES,
    PROVIDER_CATALOG,
    ROLE_SERVED_NAMES,
    build_litellm_params,
    default_endpoint_for_provider,
)
from .token_cost import estimate_llm_call_cost_from_payload, parse_recorded_estimated_cost

logger = logging.getLogger("synesis.admin.models")


DEFAULT_ROLE_ASSIGNMENTS: tuple[dict[str, Any], ...] = (
    {
        "role": "router",
        "provider": "xai",
        "model": "grok-4.3",
        "max_tokens": 4096,
        "temperature": 0.1,
        "reasoning_effort": "low",
        "description": "Default fast routing and planning model",
    },
    {
        "role": "planner",
        "provider": "xai",
        "model": "grok-4.3",
        "max_tokens": 4096,
        "temperature": 0.0,
        "reasoning_effort": "low",
        "description": "Default structured planning model",
    },
    {
        "role": "writer",
        "provider": "deepinfra",
        "model": "deepseek-ai/DeepSeek-V3.2",
        "max_tokens": 32768,
        "temperature": 0.3,
        "description": "Default final answer writer model",
    },
    {
        "role": "writer-pulse",
        "provider": "deepinfra",
        "model": "deepseek-ai/DeepSeek-V3.2",
        "max_tokens": 8192,
        "temperature": 0.3,
        "description": "Default fast writer tier",
    },
    {
        "role": "writer-core",
        "provider": "deepinfra",
        "model": "deepseek-ai/DeepSeek-V3.2",
        "max_tokens": 16384,
        "temperature": 0.3,
        "description": "Default balanced writer tier",
    },
    {
        "role": "writer-horizon",
        "provider": "deepinfra",
        "model": "deepseek-ai/DeepSeek-V3.2",
        "max_tokens": 32768,
        "temperature": 0.3,
        "description": "Default deep writer tier",
    },
    {
        "role": "ambiguity-scorer",
        "provider": "xai",
        "model": "grok-4.3",
        "max_tokens": 512,
        "temperature": 0.0,
        "reasoning_effort": "low",
        "description": "Default clarification ambiguity scorer",
    },
    {
        "role": "summarizer",
        "provider": "xai",
        "model": "grok-4.3",
        "max_tokens": 2048,
        "temperature": 0.1,
        "reasoning_effort": "low",
        "description": "Default compact summarization model",
    },
    {
        "role": "general",
        "provider": "deepinfra",
        "model": "deepseek-ai/DeepSeek-V3.2",
        "max_tokens": 32768,
        "temperature": 0.3,
        "description": "Default general synthesis model",
    },
    {
        "role": "general-pulse",
        "provider": "deepinfra",
        "model": "deepseek-ai/DeepSeek-V3.2",
        "max_tokens": 8192,
        "temperature": 0.3,
        "description": "Default fast general tier",
    },
    {
        "role": "general-core",
        "provider": "deepinfra",
        "model": "deepseek-ai/DeepSeek-V3.2",
        "max_tokens": 16384,
        "temperature": 0.3,
        "description": "Default balanced general tier",
    },
    {
        "role": "general-horizon",
        "provider": "deepinfra",
        "model": "deepseek-ai/DeepSeek-V3.2",
        "max_tokens": 32768,
        "temperature": 0.3,
        "description": "Default deep general tier",
    },
    {
        "role": "critic",
        "provider": "openrouter",
        "model": "deepseek/deepseek-r1-distill-qwen-32b",
        "max_tokens": 4096,
        "temperature": 0.1,
        "description": "Default critique and verification model",
    },
    {
        "role": "coder-pulse",
        "provider": "openrouter",
        "model": "qwen/qwen-2.5-coder-32b-instruct",
        "max_tokens": 8192,
        "temperature": 0.2,
        "description": "Default fast coder tier",
    },
    {
        "role": "coder-core",
        "provider": "openrouter",
        "model": "qwen/qwen-2.5-coder-32b-instruct",
        "max_tokens": 16384,
        "temperature": 0.2,
        "description": "Default balanced coder tier",
    },
    {
        "role": "coder-horizon",
        "provider": "openrouter",
        "model": "qwen/qwen-2.5-coder-32b-instruct",
        "max_tokens": 32768,
        "temperature": 0.2,
        "description": "Default deep coder tier",
    },
    {
        "role": "coder-compaction",
        "provider": "xai",
        "model": "grok-4.3",
        "max_tokens": 4096,
        "temperature": 0.1,
        "reasoning_effort": "low",
        "description": "Default coder context compaction model",
    },
    {
        "role": "coder-normalizer",
        "provider": "xai",
        "model": "grok-4.3",
        "max_tokens": 4096,
        "temperature": 0.0,
        "reasoning_effort": "low",
        "description": "Default validation normalization model",
    },
    {
        "role": "indexer-enrich",
        "provider": "deepinfra",
        "model": "deepseek-ai/DeepSeek-V3.2",
        "max_tokens": 4096,
        "temperature": 0.1,
        "description": "Default indexer enrichment model",
    },
)


def _source_for_provider(provider: str) -> str:
    return provider if provider in ("vllm", "kserve", "openrouter") else "external"


def _normalize_fallbacks(raw: Any, served_name: str = "") -> list[str] | None:
    """Normalize fallback route names from API/UI payloads."""
    if raw is None:
        return None
    vals: list[str] = []
    if isinstance(raw, str):
        vals = [v.strip() for v in raw.split(",")]
    elif isinstance(raw, list):
        vals = [str(v).strip() for v in raw]
    else:
        return None
    out: list[str] = []
    seen: set[str] = set()
    for v in vals:
        if not v:
            continue
        if served_name and v == served_name:
            continue
        if v in seen:
            continue
        out.append(v)
        seen.add(v)
    return out or None


# ---------------------------------------------------------------------------
# DB-first model registry queries
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProviderGovernanceMaps:
    """Non-empty ProviderConfig fields keyed by provider_key (see provider_catalog docstring)."""

    default_endpoints: dict[str, str]
    api_key_envs: dict[str, str]
    litellm_prefixes: dict[str, str]


class ResolvedDeploymentRouting(NamedTuple):
    """Canonical runtime routing for one deployment row (merged with governance)."""

    litellm_params: dict[str, Any]
    effective_api_key_env: str
    resolved_endpoint: str


async def load_provider_governance_maps() -> ProviderGovernanceMaps:
    """Load ProviderConfig-derived maps (non-empty columns only)."""
    async with async_session() as session:
        result = await session.execute(
            select(
                ProviderConfig.provider_key,
                ProviderConfig.default_endpoint,
                ProviderConfig.api_key_env,
                ProviderConfig.litellm_prefix,
            )
        )
        endpoints: dict[str, str] = {}
        key_envs: dict[str, str] = {}
        prefixes: dict[str, str] = {}
        for pk, de, ake, lpf in result.all():
            pks = str(pk)
            if de and str(de).strip():
                endpoints[pks] = str(de).strip()
            if ake and str(ake).strip():
                key_envs[pks] = str(ake).strip()
            if lpf and str(lpf).strip():
                prefixes[pks] = str(lpf).strip()
    return ProviderGovernanceMaps(endpoints, key_envs, prefixes)


async def _provider_default_endpoint_overrides() -> dict[str, str]:
    """provider_key → DB default_endpoint (non-empty only). Merged with static catalog in resolution."""
    maps = await load_provider_governance_maps()
    return maps.default_endpoints


def _merged_catalog_endpoint(provider: str, overrides: dict[str, str] | None) -> str:
    p = (provider or "").strip()
    if overrides:
        v = overrides.get(p) or overrides.get(p.lower(), "")
        if isinstance(v, str) and v.strip():
            return v.strip()
    return default_endpoint_for_provider(p)


def _merged_governance_key_env(provider: str, overrides: dict[str, str] | None) -> str:
    p = (provider or "").strip()
    if not overrides or not p:
        return ""
    v = overrides.get(p) or overrides.get(p.lower(), "")
    return v.strip() if isinstance(v, str) else ""


def _merged_governance_litellm_prefix(provider: str, overrides: dict[str, str] | None) -> str:
    p = (provider or "").strip()
    if not overrides or not p:
        return ""
    v = overrides.get(p) or overrides.get(p.lower(), "")
    return v.strip() if isinstance(v, str) else ""


def _resolve_role_endpoint(
    *,
    provider: str,
    endpoint_field: str,
    stored_litellm_params: dict | None,
    maps: ProviderGovernanceMaps,
) -> str:
    prov_info = PROVIDER_CATALOG.get(provider, PROVIDER_CATALOG["custom"])
    catalog_eff = _merged_catalog_endpoint(provider, maps.default_endpoints)
    lp_stored = dict(stored_litellm_params or {})
    if prov_info.needs_endpoint:
        return (endpoint_field or "").strip() or str(lp_stored.get("api_base") or "").strip() or catalog_eff
    return catalog_eff or (endpoint_field or "").strip() or str(lp_stored.get("api_base") or "").strip()


def _coerce_optional_float(raw: Any) -> float | None:
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _coerce_optional_int(raw: Any) -> int | None:
    if raw is None:
        return None
    try:
        return int(float(raw))
    except (TypeError, ValueError):
        return None


def _coerce_optional_bool(raw: Any) -> bool | None:
    if raw is None:
        return None
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    s = str(raw).strip().lower()
    if s in {"true", "1", "yes", "on"}:
        return True
    if s in {"false", "0", "no", "off"}:
        return False
    return None


def _coerce_reasoning_effort(raw: Any) -> str | None:
    if raw is None:
        return None
    s = str(raw).strip().lower()
    if s in {"none", "low", "medium", "high", "xhigh", "default"}:
        return s
    return None


def resolve_deployment_routing_for_parts(
    *,
    provider: str,
    model: str,
    endpoint_field: str,
    api_key_env_field: str,
    stored_litellm_params: dict | None,
    maps: ProviderGovernanceMaps,
    max_tokens: int | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
    top_k: int | None = None,
    min_p: float | None = None,
    presence_penalty: float | None = None,
    repetition_penalty: float | None = None,
    enable_thinking: bool | None = None,
    reasoning_effort: str | None = None,
) -> ResolvedDeploymentRouting:
    """Merge catalog + governance + assignment fields into route params."""
    p = (provider or "").strip()
    prov_info = PROVIDER_CATALOG.get(p, PROVIDER_CATALOG["custom"])
    lp_stored = dict(stored_litellm_params or {})
    mt = int(max_tokens if max_tokens is not None else lp_stored.get("max_tokens") or 8192)
    temp = float(temperature if temperature is not None else lp_stored.get("temperature") or 0.3)
    eff_top_p = _coerce_optional_float(top_p if top_p is not None else lp_stored.get("top_p"))
    eff_top_k = _coerce_optional_int(top_k if top_k is not None else lp_stored.get("top_k"))
    eff_min_p = _coerce_optional_float(min_p if min_p is not None else lp_stored.get("min_p"))
    eff_presence_penalty = _coerce_optional_float(
        presence_penalty if presence_penalty is not None else lp_stored.get("presence_penalty")
    )
    eff_repetition_penalty = _coerce_optional_float(
        repetition_penalty if repetition_penalty is not None else lp_stored.get("repetition_penalty")
    )
    eff_enable_thinking = _coerce_optional_bool(
        enable_thinking if enable_thinking is not None else lp_stored.get("enable_thinking")
    )
    eff_reasoning_effort = _coerce_reasoning_effort(
        reasoning_effort if reasoning_effort is not None else lp_stored.get("reasoning_effort")
    )
    resolved_endpoint = _resolve_role_endpoint(
        provider=p,
        endpoint_field=endpoint_field,
        stored_litellm_params=stored_litellm_params,
        maps=maps,
    )
    gov_key = _merged_governance_key_env(p, maps.api_key_envs)
    effective_api_key_env = (api_key_env_field or "").strip() or gov_key or (prov_info.api_key_env or "")
    prefix_ov = _merged_governance_litellm_prefix(p, maps.litellm_prefixes)
    lp = build_litellm_params(
        p,
        model,
        endpoint=resolved_endpoint,
        api_key_env=effective_api_key_env,
        max_tokens=mt,
        temperature=temp,
        top_p=eff_top_p,
        top_k=eff_top_k,
        min_p=eff_min_p,
        presence_penalty=eff_presence_penalty,
        repetition_penalty=eff_repetition_penalty,
        enable_thinking=eff_enable_thinking,
        reasoning_effort=eff_reasoning_effort,
        litellm_prefix_override=prefix_ov,
    )
    return ResolvedDeploymentRouting(lp, effective_api_key_env, resolved_endpoint)


def resolve_deployment_routing_for_deployment(
    row: ModelDeployment,
    maps: ProviderGovernanceMaps,
) -> ResolvedDeploymentRouting:
    """Canonical routing for an existing ORM row (API + reconciler)."""
    p = (row.provider or row.source or "").strip()
    return resolve_deployment_routing_for_parts(
        provider=p,
        model=row.model,
        endpoint_field=(row.endpoint or "").strip(),
        api_key_env_field=(row.api_key_env or "").strip(),
        stored_litellm_params=row.litellm_params,
        maps=maps,
        max_tokens=None,
        temperature=None,
    )


async def get_model_deployments() -> list[dict]:
    """Return all model deployments from DB."""
    maps = await load_provider_governance_maps()
    async with async_session() as session:
        result = await session.execute(select(ModelDeployment).order_by(ModelDeployment.role))
        rows = result.scalars().all()
        return [_deployment_to_dict(r, maps) for r in rows]


async def get_active_deployments() -> list[ModelDeployment]:
    """Return ORM rows for all active deployments."""
    async with async_session() as session:
        result = await session.execute(select(ModelDeployment).where(ModelDeployment.is_active == True))
        return list(result.scalars().all())


async def seed_default_role_assignments() -> int:
    """Create default active role assignments for empty installs.

    This is intentionally non-destructive: existing active role assignments are
    never changed here. The Admin registry is the source of truth for direct
    model runtime routes.
    """
    maps = await load_provider_governance_maps()
    async with async_session() as session:
        result = await session.execute(select(ModelDeployment.role).where(ModelDeployment.is_active == True))
        active_roles = {str(row[0]) for row in result.all()}

        created = 0
        for seed in DEFAULT_ROLE_ASSIGNMENTS:
            role = str(seed["role"])
            if role in active_roles:
                continue

            provider = str(seed["provider"])
            model = str(seed["model"])
            served_name = ROLE_SERVED_NAMES.get(role, f"synesis-{role}")
            routing = resolve_deployment_routing_for_parts(
                provider=provider,
                model=model,
                endpoint_field="",
                api_key_env_field="",
                stored_litellm_params=None,
                maps=maps,
                max_tokens=int(seed["max_tokens"]),
                temperature=float(seed["temperature"]),
                reasoning_effort=seed.get("reasoning_effort"),
            )
            session.add(
                ModelDeployment(
                    role=role,
                    model=model,
                    endpoint=routing.resolved_endpoint,
                    served_name=served_name,
                    status="active",
                    source=_source_for_provider(provider),
                    provider=provider,
                    api_key_env=routing.effective_api_key_env,
                    litellm_params=routing.litellm_params,
                    is_active=True,
                    description=str(seed.get("description") or "Seeded default role assignment"),
                    notes="Seeded by Synesis Admin startup; change this role in Model Registry.",
                )
            )
            active_roles.add(role)
            created += 1

        if created:
            await session.commit()
    return created


async def get_deployment_by_id(deployment_id: int) -> ModelDeployment | None:
    async with async_session() as session:
        return await session.get(ModelDeployment, deployment_id)


async def create_deployment(data: dict) -> dict:
    async with async_session() as session:
        row = ModelDeployment(
            environment=(data.get("environment") or "") or "",
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
        maps = await load_provider_governance_maps()
        return _deployment_to_dict(row, maps)


async def update_deployment(deployment_id: int, data: dict) -> dict | None:
    async with async_session() as session:
        row = await session.get(ModelDeployment, deployment_id)
        if row is None:
            return None
        for field in (
            "model",
            "endpoint",
            "served_name",
            "status",
            "profile",
            "source",
            "litellm_params",
            "is_active",
            "description",
            "notes",
            "gpu_config",
            "environment",
            "role",
            "fallbacks",
        ):
            if field in data:
                if field == "fallbacks":
                    setattr(row, field, _normalize_fallbacks(data[field], row.served_name))
                else:
                    setattr(row, field, data[field])
        await session.commit()
        await session.refresh(row)
        maps = await load_provider_governance_maps()
        return _deployment_to_dict(row, maps)


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
            row.status = "active"
        else:
            row.status = "configured"
            row.litellm_model_id = None
        await session.commit()
        await session.refresh(row)
        maps = await load_provider_governance_maps()
        return _deployment_to_dict(row, maps)


def _deployment_to_dict(row: ModelDeployment, maps: ProviderGovernanceMaps) -> dict:
    routing = resolve_deployment_routing_for_deployment(row, maps)
    provider = row.provider or row.source
    return {
        "id": row.id,
        "environment": row.environment or "",
        "role": row.role,
        "model": row.model,
        "endpoint": routing.resolved_endpoint,
        "served_name": row.served_name,
        "status": row.status,
        "profile": row.profile,
        "provider": provider,
        "source": row.source,
        "api_key_env": routing.effective_api_key_env,
        "litellm_params": routing.litellm_params,
        "is_active": row.is_active,
        "description": row.description,
        "notes": row.notes,
        "gpu_config": row.gpu_config,
        "litellm_model_id": row.litellm_model_id,
        "fallbacks": row.fallbacks,
        "adapter_hint": row.adapter_hint,
        "context_window": row.context_window,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


# ---------------------------------------------------------------------------
# Role-first registry (primary API)
# ---------------------------------------------------------------------------


async def get_role_assignments() -> list[dict]:
    """Return one entry per canonical role with the active assignment (or unassigned)."""
    maps = await load_provider_governance_maps()
    async with async_session() as session:
        result = await session.execute(select(ModelDeployment).where(ModelDeployment.is_active == True))
        active = {r.role: r for r in result.scalars().all()}

    assignments = []
    for role in KNOWN_ROLES:
        row = active.get(role)
        if row:
            d = _deployment_to_dict(row, maps)
            d["assigned"] = True
        else:
            d = {
                "id": None,
                "role": role,
                "model": "",
                "endpoint": "",
                "served_name": ROLE_SERVED_NAMES.get(role, f"synesis-{role}"),
                "status": "unassigned",
                "provider": "",
                "api_key_env": "",
                "litellm_params": None,
                "is_active": False,
                "description": "",
                "notes": "",
                "litellm_model_id": None,
                "fallbacks": None,
                "updated_at": None,
                "assigned": False,
                "environment": "",
                "profile": "",
                "source": "",
                "gpu_config": None,
                "adapter_hint": None,
                "context_window": None,
            }
        assignments.append(d)
    return assignments


async def assign_role(
    role: str,
    provider: str,
    model: str,
    *,
    endpoint: str = "",
    api_key_env: str = "",
    max_tokens: int = 8192,
    temperature: float = 0.3,
    top_p: float | None = None,
    top_k: int | None = None,
    min_p: float | None = None,
    presence_penalty: float | None = None,
    repetition_penalty: float | None = None,
    enable_thinking: bool | None = None,
    reasoning_effort: str | None = None,
    fallbacks: list[str] | None = None,
    adapter_hint: str | None = None,
    context_window: int | None = None,
    description: str = "",
    notes: str = "",
) -> dict:
    """Assign a provider + model to a canonical role.

    Deactivates the previous assignment (writing history), then creates or
    updates the active deployment for this role.  Returns the new assignment dict.

    NOTE: Role defaults are persisted in the deployment route parameters and can include
    provider-specific generation controls (temperature/top_p/top_k/min_p/
    presence_penalty/repetition_penalty/enable_thinking/reasoning_effort). Runtime request
    payloads may override these at call-time.
    """
    if role not in KNOWN_ROLES:
        raise ValueError(f"Unknown role: {role}")

    served_name = ROLE_SERVED_NAMES.get(role, f"synesis-{role}")
    norm_fallbacks = _normalize_fallbacks(fallbacks, served_name)
    maps = await load_provider_governance_maps()
    routing = resolve_deployment_routing_for_parts(
        provider=provider,
        model=model,
        endpoint_field=(endpoint or "").strip(),
        api_key_env_field=(api_key_env or "").strip(),
        stored_litellm_params=None,
        maps=maps,
        max_tokens=max_tokens,
        temperature=temperature,
        top_p=top_p,
        top_k=top_k,
        min_p=min_p,
        presence_penalty=presence_penalty,
        repetition_penalty=repetition_penalty,
        enable_thinking=enable_thinking,
        reasoning_effort=reasoning_effort,
    )
    lp = routing.litellm_params
    effective_api_key_env = routing.effective_api_key_env
    resolved_endpoint = routing.resolved_endpoint

    async with async_session() as session:
        # Deactivate current active assignment for this role (if any).
        result = await session.execute(
            select(ModelDeployment).where(
                ModelDeployment.role == role,
                ModelDeployment.is_active == True,
            )
        )
        old_row = result.scalar_one_or_none()
        if old_row is not None:
            old_row.is_active = False
            old_row.status = "replaced"
            old_row.litellm_model_id = None
            # Write history record for the departing assignment.
            session.add(
                ModelRoleHistory(
                    role=role,
                    provider=old_row.provider or old_row.source,
                    model=old_row.model,
                    endpoint=old_row.endpoint,
                    deactivated_at=datetime.now(UTC),
                )
            )

        # Create new active deployment.
        row = ModelDeployment(
            role=role,
            model=model,
            endpoint=resolved_endpoint,
            served_name=served_name,
            status="active",
            source=_source_for_provider(provider),
            provider=provider,
            api_key_env=effective_api_key_env,
            litellm_params=lp,
            is_active=True,
            description=description,
            notes=notes,
            fallbacks=norm_fallbacks,
            adapter_hint=adapter_hint or None,
            context_window=context_window,
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        d = _deployment_to_dict(row, maps)
        d["assigned"] = True
        return d


async def deactivate_role(role: str) -> dict | None:
    """Deactivate the active assignment for a role."""
    maps = await load_provider_governance_maps()
    async with async_session() as session:
        result = await session.execute(
            select(ModelDeployment).where(
                ModelDeployment.role == role,
                ModelDeployment.is_active == True,
            )
        )
        row = result.scalar_one_or_none()
        if row is None:
            return None
        row.is_active = False
        row.status = "deactivated"
        row.litellm_model_id = None
        session.add(
            ModelRoleHistory(
                role=role,
                provider=row.provider or row.source,
                model=row.model,
                endpoint=row.endpoint,
                deactivated_at=datetime.now(UTC),
            )
        )
        await session.commit()
        await session.refresh(row)
        return _deployment_to_dict(row, maps)


async def get_role_history(role: str, *, days: int = 90) -> list[dict]:
    """Return historical assignments for a role."""
    async with async_session() as session:
        result = await session.execute(
            select(ModelRoleHistory)
            .where(ModelRoleHistory.role == role)
            .order_by(ModelRoleHistory.activated_at.desc())
            .limit(50)
        )
        rows = result.scalars().all()
        return [
            {
                "id": r.id,
                "role": r.role,
                "provider": r.provider,
                "model": r.model,
                "endpoint": r.endpoint,
                "input_per_million": r.input_per_million,
                "output_per_million": r.output_per_million,
                "activated_at": r.activated_at.isoformat() if r.activated_at else None,
                "deactivated_at": r.deactivated_at.isoformat() if r.deactivated_at else None,
            }
            for r in rows
        ]


# ---------------------------------------------------------------------------
# Topology (DB deployments — single install, no multi-environment grouping)
# ---------------------------------------------------------------------------


async def get_model_topology() -> dict:
    """Return all deployments as a flat list with canonical role names."""
    deployments = await get_model_deployments()
    flat = [
        {
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
        }
        for d in deployments
    ]
    if flat:
        return {"deployments": flat, "roles": list(KNOWN_ROLES)}
    return {"deployments": [], "roles": list(KNOWN_ROLES)}


# ---------------------------------------------------------------------------
# Cost estimates (registry + model_costs for canonical roles only)
# ---------------------------------------------------------------------------


def _infer_role_for_cost(node_name: str, model_name: str) -> str:
    """Match trace LLM calls to pipeline roles (same rules as models router)."""
    node_lower = node_name.lower()
    model_lower = (model_name or "").lower()
    if "summarizer" in node_lower or "summar" in node_lower or "synesis-summarizer" in model_lower:
        return "summarizer"
    if "planner" in node_lower or "synesis-planner" in model_lower:
        return "planner"
    if "router" in node_lower or "router" in model_lower:
        return "router"
    if "critic" in node_lower or "critic" in model_lower:
        return "critic"
    if "coder" in node_lower or "coder" in model_lower:
        return "coder"
    if "writer" in node_lower or "writer" in model_lower:
        return "writer"
    if "general" in model_lower:
        return "general"
    return node_name or "unknown"


async def get_cost_estimates() -> list[dict]:
    """One row per canonical role: model/provider from active assignment; rates from model_costs (profile empty)."""
    assignments = await get_role_assignments()
    try:
        async with async_session() as session:
            result = await session.execute(select(ModelCostRow))
            db_rows = result.scalars().all()
    except Exception:
        logger.debug("model_costs_db_read_failed", exc_info=True)
        db_rows = []

    db_by_role: dict[str, ModelCostRow] = {}
    for row in db_rows:
        if row.role not in KNOWN_ROLES:
            continue
        prof = (row.profile or "").strip()
        if prof == "" or row.role not in db_by_role:
            db_by_role[row.role] = row

    merged: list[dict] = []
    for a in assignments:
        role = a["role"]
        if role not in KNOWN_ROLES:
            continue
        prof = ""
        db_row = db_by_role.get(role)
        model = a.get("model", "") if a.get("assigned") else ""
        provider = (a.get("provider") or "") if a.get("assigned") else ""
        src = (a.get("source") or "") if a.get("assigned") else "local"
        if db_row:
            merged.append(
                {
                    "role": role,
                    "model": model,
                    "profile": prof,
                    "source": src or db_row.source or "local",
                    "provider": provider,
                    "served_name": a.get("served_name", ROLE_SERVED_NAMES.get(role, f"synesis-{role}")),
                    "input_per_million": db_row.input_per_million,
                    "input_cached_per_million": db_row.input_cached_per_million,
                    "input_cache_write_per_million": db_row.input_cache_write_per_million,
                    "output_per_million": db_row.output_per_million,
                    "monthly_fixed_cost": db_row.monthly_fixed_cost,
                    "cost_formula": db_row.cost_formula,
                    "notes": db_row.notes,
                }
            )
        else:
            merged.append(
                {
                    "role": role,
                    "model": model,
                    "profile": prof,
                    "source": src or "local",
                    "provider": provider,
                    "served_name": a.get("served_name", ROLE_SERVED_NAMES.get(role, f"synesis-{role}")),
                    "input_per_million": 0.0,
                    "input_cached_per_million": None,
                    "input_cache_write_per_million": None,
                    "output_per_million": 0.0,
                    "monthly_fixed_cost": 0.0,
                    "cost_formula": "",
                    "notes": "",
                }
            )
    return merged


async def upsert_model_cost(data: dict) -> dict:
    role = data["role"]
    profile = (data.get("profile") or "").strip()
    if role in KNOWN_ROLES:
        profile = ""
    async with async_session() as session:
        # Registry model for canonical roles (never drift from active assignment).
        registry_model = ""
        if role in KNOWN_ROLES:
            r = await session.execute(
                select(ModelDeployment).where(
                    ModelDeployment.role == role,
                    ModelDeployment.is_active == True,
                )
            )
            active = r.scalar_one_or_none()
            if active is not None:
                registry_model = active.model or ""

        q = select(ModelCostRow).where(
            ModelCostRow.role == role,
            ModelCostRow.profile == profile,
        )
        result = await session.execute(q)
        row = result.scalar_one_or_none()
        if row is None:
            row = ModelCostRow(
                role=role,
                model=registry_model or data.get("model", ""),
                profile=profile,
            )
            session.add(row)
        row.source = data.get("source", row.source or "local")
        row.input_per_million = data.get("input_per_million", row.input_per_million)
        if "input_cached_per_million" in data:
            ic = data["input_cached_per_million"]
            row.input_cached_per_million = ic if ic is not None else None
        if "input_cache_write_per_million" in data:
            icw = data["input_cache_write_per_million"]
            row.input_cache_write_per_million = icw if icw is not None else None
        row.output_per_million = data.get("output_per_million", row.output_per_million)
        row.monthly_fixed_cost = data.get("monthly_fixed_cost", row.monthly_fixed_cost)
        row.cost_formula = data.get("cost_formula", row.cost_formula)
        row.notes = data.get("notes", row.notes)
        row.model = registry_model if registry_model else data.get("model", row.model)
        await session.commit()
        await session.refresh(row)
        return {
            "id": row.id,
            "role": row.role,
            "model": row.model,
            "profile": row.profile,
            "source": row.source,
            "input_per_million": row.input_per_million,
            "input_cached_per_million": row.input_cached_per_million,
            "input_cache_write_per_million": row.input_cache_write_per_million,
            "output_per_million": row.output_per_million,
            "monthly_fixed_cost": row.monthly_fixed_cost,
            "cost_formula": row.cost_formula,
            "notes": row.notes,
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
            costs = await get_cost_estimates()
            pricing_by_role: dict[str, tuple[float, float, float | None, float | None]] = {
                c.get("role", ""): (
                    c["input_per_million"],
                    c["output_per_million"],
                    c.get("input_cached_per_million"),
                    c.get("input_cache_write_per_million"),
                )
                for c in costs
            }
            for row in rows:
                full = row.full_record or {}
                for span in full.get("spans", []):
                    node = span.get("node_name", "unknown")
                    for call in span.get("llm_calls", []):
                        model = call.get("model", "unknown")
                        if model not in model_agg:
                            model_agg[model] = {
                                "model": model,
                                "prompt_tokens": 0,
                                "completion_tokens": 0,
                                "cached_prompt_tokens": 0,
                                "total_tokens": 0,
                                "requests": 0,
                                "cost_usd": 0.0,
                            }
                        agg = model_agg[model]
                        agg["prompt_tokens"] += call.get("prompt_tokens", 0)
                        agg["completion_tokens"] += call.get("completion_tokens", 0)
                        agg["cached_prompt_tokens"] += call.get("cached_prompt_tokens", 0)
                        agg["total_tokens"] += call.get("total_tokens", 0)
                        agg["requests"] += 1
                        role = _infer_role_for_cost(node, call.get("model", ""))
                        inp_r, out_r, ic_r, icw_r = pricing_by_role.get(role, (0.0, 0.0, None, None))
                        est = parse_recorded_estimated_cost(call)
                        agg["cost_usd"] += (
                            est
                            if est is not None
                            else estimate_llm_call_cost_from_payload(
                                call,
                                input_per_million=inp_r,
                                output_per_million=out_r,
                                input_cached_per_million=ic_r,
                                input_cache_write_per_million=icw_r,
                            )
                        )

            for agg in model_agg.values():
                agg["cost_usd"] = round(float(agg["cost_usd"]), 6)

            return sorted(model_agg.values(), key=lambda x: x["cost_usd"], reverse=True)
        except Exception:
            logger.warning("cost_by_model_failed", exc_info=True)
            return []
