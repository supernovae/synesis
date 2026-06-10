"""Provider Governance API — provider enablement, defaults, and policies.

ProviderConfig rows are the database source for: ``default_endpoint``,
``api_key_env``, ``route_prefix`` (custom providers), enablement, and policies.
Model Registry assignments inherit these via ``resolve_deployment_routing_*`` in
``model_registry`` (see ``provider_catalog`` module docstring).
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Body, Depends, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import ProviderConfig
from ..rbac import require_platform_admin
from ..services.admin_audit import record_admin_audit
from ..services.provider_catalog import KNOWN_ROLES, PROVIDER_CATALOG, default_endpoint_for_provider, get_catalog

logger = logging.getLogger("synesis.admin.provider_governance")

router = APIRouter(prefix="/api/v1/provider-governance", tags=["provider-governance"])

_KEY_RE = re.compile(r"^[a-z0-9_-]{2,64}$")
KNOWN_ROLE_SET = frozenset(KNOWN_ROLES)


class ProviderCreateBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    key: str = Field(..., min_length=2, max_length=64)
    label: str = Field(..., min_length=1, max_length=128)
    route_prefix: str = Field("openai/", max_length=64)
    api_key_env: str = Field("", max_length=128)
    needs_endpoint: bool = True
    placeholder: str = Field("model-name", max_length=256)
    is_local: bool = False
    enabled: bool = True
    default_endpoint: str = Field("", max_length=2048)
    default_max_tokens: int = Field(8192, ge=1, le=1048576)
    default_temperature: float = Field(0.1, ge=0, le=5)
    notes: str = Field("", max_length=4000)


class ProviderUpdateBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    enabled: bool | None = None
    default_max_tokens: int | None = Field(None, ge=1, le=1048576)
    default_temperature: float | None = Field(None, ge=0, le=5)
    allowed_roles: list[str] | None = Field(None, max_length=len(KNOWN_ROLES))
    notes: str | None = Field(None, max_length=4000)
    default_endpoint: str | None = Field(None, max_length=2048)
    label: str | None = Field(None, max_length=128)
    route_prefix: str | None = Field(None, max_length=64)
    api_key_env: str | None = Field(None, max_length=128)
    needs_endpoint: bool | None = None
    placeholder: str | None = Field(None, max_length=256)
    is_local: bool | None = None

    @field_validator("allowed_roles", mode="before")
    @classmethod
    def _validate_allowed_roles(cls, value: object) -> list[str] | None:
        if value is None:
            return None
        if not isinstance(value, list):
            raise ValueError("allowed_roles must be a list")
        cleaned: list[str] = []
        invalid: list[str] = []
        for raw_role in value:
            role = str(raw_role or "").strip()
            if role not in KNOWN_ROLE_SET:
                invalid.append(role)
                continue
            if role not in cleaned:
                cleaned.append(role)
        if invalid:
            raise ValueError(f"allowed_roles must be known model roles: {sorted(KNOWN_ROLE_SET)}")
        return cleaned


async def seed_provider_configs() -> int:
    """Ensure every catalog provider has a ProviderConfig row.

    Runs on startup so Provider Management is the single source of truth for
    enablement, defaults, and governance — no more "absent row = enabled".
    Returns the number of newly created rows.
    """
    async with async_session() as session:
        result = await session.execute(select(ProviderConfig.provider_key))
        existing = {row[0] for row in result.all()}

        created = 0
        for key in PROVIDER_CATALOG:
            if key not in existing:
                session.add(ProviderConfig(provider_key=key))
                created += 1

        if created:
            await session.commit()
    return created


async def get_disabled_provider_keys() -> frozenset[str]:
    """Return the set of provider keys that are disabled in provider governance."""
    async with async_session() as session:
        result = await session.execute(select(ProviderConfig.provider_key).where(ProviderConfig.enabled == False))
        return frozenset(row[0] for row in result.all())


def _row_to_config_dict(r: ProviderConfig) -> dict:
    return {
        "id": r.id,
        "provider_key": r.provider_key,
        "enabled": r.enabled,
        "default_max_tokens": r.default_max_tokens,
        "default_temperature": r.default_temperature,
        "allowed_roles": r.allowed_roles,
        "policies": r.policies,
        "notes": r.notes,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        "is_custom": r.is_custom,
        "default_endpoint": (r.default_endpoint or "").strip() or None,
        # DB-stored routing metadata (custom providers); built-ins often null → use catalog top-level.
        "api_key_env": (r.api_key_env or "").strip() or None,
        "route_prefix": (r.route_prefix or "").strip() or None,
    }


def _effective_default_endpoint(row: ProviderConfig | None, provider_key: str) -> str:
    db_ep = (row.default_endpoint or "").strip() if row else ""
    if db_ep:
        return db_ep
    return default_endpoint_for_provider(provider_key)


def _effective_provider_fields(info: dict, row: ProviderConfig | None) -> dict:
    """Merge catalog provider info with ProviderConfig overrides (for built-ins and custom)."""
    return {
        **info,
        "label": (row.label or info.get("label", "")) if row else info.get("label", ""),
        "route_prefix": (row.route_prefix or info.get("route_prefix", "")) if row else info.get("route_prefix", ""),
        "api_key_env": (row.api_key_env or info.get("api_key_env", "")) if row else info.get("api_key_env", ""),
        "needs_endpoint": row.needs_endpoint
        if (row and row.needs_endpoint is not None)
        else info.get("needs_endpoint", False),
        "placeholder": (row.placeholder or info.get("placeholder", "")) if row else info.get("placeholder", ""),
        "is_local": bool(row.is_local) if row and row.is_local is not None else bool(info.get("is_local", False)),
    }


async def _get_all_configs() -> dict[str, dict]:
    """Load all ProviderConfig rows, keyed by provider_key."""
    async with async_session() as session:
        result = await session.execute(select(ProviderConfig))
        rows = result.scalars().all()
    return {r.provider_key: _row_to_config_dict(r) for r in rows}


async def _get_all_config_rows() -> dict[str, ProviderConfig]:
    async with async_session() as session:
        result = await session.execute(select(ProviderConfig))
        rows = result.scalars().all()
    return {r.provider_key: r for r in rows}


async def _get_custom_rows() -> list[ProviderConfig]:
    """Return all custom (user-defined) provider rows."""
    async with async_session() as session:
        result = await session.execute(select(ProviderConfig).where(ProviderConfig.is_custom == True))
        return list(result.scalars().all())


def _custom_row_to_provider(r: ProviderConfig) -> dict:
    """Build a provider info dict from a custom DB row (no catalog entry)."""
    return {
        "key": r.provider_key,
        "label": r.label or r.provider_key,
        "route_prefix": r.route_prefix or "openai/",
        "api_key_env": r.api_key_env or "",
        "needs_endpoint": r.needs_endpoint if r.needs_endpoint is not None else True,
        "placeholder": r.placeholder or "model-name",
        "is_local": r.is_local or False,
        "supports_discovery": False,
        "is_custom": True,
        "default_endpoint": _effective_default_endpoint(r, r.provider_key),
        "config": _row_to_config_dict(r),
        "enabled": r.enabled,
        "default_max_tokens": r.default_max_tokens,
        "default_temperature": r.default_temperature,
        "allowed_roles": r.allowed_roles,
        "policies": r.policies,
        "notes": r.notes,
        "config_updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


def _attach_api_key_configured(entry: dict, configured_key_names: set[str]) -> None:
    env = (entry.get("api_key_env") or "").strip()
    if not env:
        entry["api_key_configured"] = None
    else:
        entry["api_key_configured"] = env in configured_key_names


async def _configured_secret_key_names() -> set[str]:
    """Return K8s secret data keys (env var names). Empty if unavailable (e.g. local dev)."""
    try:
        from ..routers import providers as providers_mod

        secret = await providers_mod._get_secret()
    except HTTPException:
        logger.info("provider_secret_unavailable — governance list omits key overlay")
        return set()
    except Exception:
        logger.warning("provider_secret_read_failed", exc_info=True)
        return set()
    if not secret or not secret.get("data"):
        return set()
    return set(secret["data"].keys())


@router.get("")
async def list_provider_configs(_user: UserInfo = Depends(get_current_user)):
    """Return all providers (catalog + custom) with governance overlay and cluster key status.

    This is the admin SPA's single read for: provider policy, Model Registry picklist
    (via enabled filter), and provider API key presence (never values). ``roles`` matches
    ``GET /providers/catalog``; ``provider_secret_keys`` matches ``GET /providers/keys``.
    """
    catalog = get_catalog()
    configs = await _get_all_configs()
    rows_by_key = await _get_all_config_rows()
    configured_key_names = await _configured_secret_key_names()

    providers = []
    for key, info in catalog["providers"].items():
        cfg = configs.get(key, {})
        row = rows_by_key.get(key)
        merged_info = _effective_provider_fields(info, row)
        entry = {
            **merged_info,
            "is_custom": False,
            "default_endpoint": _effective_default_endpoint(row, key),
            "config": cfg if cfg else None,
            "enabled": cfg.get("enabled", True),
            "default_max_tokens": cfg.get("default_max_tokens", 8192),
            "default_temperature": cfg.get("default_temperature", 0.1),
            "allowed_roles": cfg.get("allowed_roles"),
            "policies": cfg.get("policies"),
            "notes": cfg.get("notes", ""),
            "config_updated_at": cfg.get("updated_at"),
        }
        _attach_api_key_configured(entry, configured_key_names)
        providers.append(entry)

    custom_rows = await _get_custom_rows()
    for r in custom_rows:
        if r.provider_key not in catalog["providers"]:
            prov = _custom_row_to_provider(r)
            _attach_api_key_configured(prov, configured_key_names)
            providers.append(prov)

    from ..routers.providers import KNOWN_PROVIDERS

    all_key_names = set(KNOWN_PROVIDERS.keys()) | configured_key_names
    provider_secret_keys = [
        {
            "name": n,
            "provider": KNOWN_PROVIDERS.get(n, "Custom"),
            "configured": n in configured_key_names,
        }
        for n in sorted(all_key_names)
    ]
    env_labels: dict[str, str] = {}
    for p in providers:
        env = (p.get("api_key_env") or "").strip()
        if env and env not in env_labels:
            env_labels[env] = p.get("label", "Custom")
    for row in provider_secret_keys:
        if row["provider"] == "Custom" and row["name"] in env_labels:
            row["provider"] = env_labels[row["name"]]

    return {
        "providers": providers,
        "roles": catalog["roles"],
        "provider_secret_keys": provider_secret_keys,
    }


@router.get("/{provider_key}")
async def get_provider_config(
    provider_key: str = Path(..., min_length=2, max_length=64, pattern=r"^[a-z0-9_-]+$"),
    _user: UserInfo = Depends(get_current_user),
):
    """Get a single provider's catalog info + governance config."""
    catalog = get_catalog()
    configs = await _get_all_configs()
    cfg = configs.get(provider_key, {})
    rows_by_key = await _get_all_config_rows()
    row = rows_by_key.get(provider_key)

    if provider_key in PROVIDER_CATALOG:
        info = catalog["providers"][provider_key]
        merged_info = _effective_provider_fields(info, row)
        return {
            **merged_info,
            "is_custom": False,
            "default_endpoint": _effective_default_endpoint(row, provider_key),
            "config": cfg if cfg else None,
            "enabled": cfg.get("enabled", True),
            "default_max_tokens": cfg.get("default_max_tokens", 8192),
            "default_temperature": cfg.get("default_temperature", 0.1),
            "allowed_roles": cfg.get("allowed_roles"),
            "policies": cfg.get("policies"),
            "notes": cfg.get("notes", ""),
        }

    if cfg and cfg.get("is_custom"):
        async with async_session() as session:
            result = await session.execute(select(ProviderConfig).where(ProviderConfig.provider_key == provider_key))
            row = result.scalar_one_or_none()
            if row:
                return _custom_row_to_provider(row)

    raise HTTPException(404, f"Unknown provider: {provider_key}")


@router.post("")
async def create_provider(
    body: ProviderCreateBody = Body(...),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Create a new custom provider."""
    data = body.model_dump()
    key = data.get("key", "").strip().lower()
    if not key or not _KEY_RE.match(key):
        raise HTTPException(400, "Provider key must be 2-64 lowercase alphanumeric/dash/underscore characters")

    if key in PROVIDER_CATALOG:
        raise HTTPException(409, f"Provider key '{key}' conflicts with a built-in catalog provider")

    async with async_session() as session:
        existing = await session.execute(select(ProviderConfig).where(ProviderConfig.provider_key == key))
        if existing.scalar_one_or_none():
            raise HTTPException(409, f"Provider key '{key}' already exists")

        de_create = str(data.get("default_endpoint", "") or "").strip()
        row = ProviderConfig(
            provider_key=key,
            is_custom=True,
            label=data.get("label", key),
            route_prefix=data.get("route_prefix", "openai/"),
            api_key_env=data.get("api_key_env", ""),
            needs_endpoint=data.get("needs_endpoint", True),
            placeholder=data.get("placeholder", "model-name"),
            is_local=data.get("is_local", False),
            enabled=data.get("enabled", True),
            default_max_tokens=int(data.get("default_max_tokens", 8192)),
            default_temperature=float(data.get("default_temperature", 0.1)),
            notes=data.get("notes", ""),
            default_endpoint=de_create or None,
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        out = _custom_row_to_provider(row)

    await record_admin_audit(
        user=_user,
        action="provider_governance.create",
        status="success",
        summary=f"Created custom provider '{key}'",
        detail={"provider_key": key},
    )
    return out


@router.put("/{provider_key}")
async def update_provider_config(
    provider_key: str = Path(..., min_length=2, max_length=64, pattern=r"^[a-z0-9_-]+$"),
    body: ProviderUpdateBody = Body(...),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Create or update governance config for a provider."""
    data = body.model_dump(exclude_unset=True)
    is_catalog = provider_key in PROVIDER_CATALOG

    async with async_session() as session:
        result = await session.execute(select(ProviderConfig).where(ProviderConfig.provider_key == provider_key))
        row = result.scalar_one_or_none()
        if row is None:
            if not is_catalog:
                raise HTTPException(404, f"Unknown provider: {provider_key}")
            row = ProviderConfig(provider_key=provider_key)
            session.add(row)

        if "enabled" in data:
            row.enabled = bool(data["enabled"])
        if "default_max_tokens" in data:
            row.default_max_tokens = int(data["default_max_tokens"])
        if "default_temperature" in data:
            row.default_temperature = float(data["default_temperature"])
        if "allowed_roles" in data:
            row.allowed_roles = data["allowed_roles"] if data["allowed_roles"] else None
        if "policies" in data:
            row.policies = data["policies"] if data["policies"] else None
        if "notes" in data:
            row.notes = str(data.get("notes", ""))

        if "default_endpoint" in data:
            ep = str(data.get("default_endpoint") or "").strip()
            row.default_endpoint = ep or None

        if "label" in data:
            row.label = data["label"]
        if "route_prefix" in data:
            row.route_prefix = data["route_prefix"]
        if "api_key_env" in data:
            row.api_key_env = data["api_key_env"]
        if "needs_endpoint" in data:
            row.needs_endpoint = data["needs_endpoint"]
        if "placeholder" in data:
            row.placeholder = data["placeholder"]
        if "is_local" in data:
            row.is_local = data["is_local"]

        await session.commit()
        await session.refresh(row)

        out = _row_to_config_dict(row)

    await record_admin_audit(
        user=_user,
        action="provider_governance.update",
        status="success",
        summary=f"Updated provider config for {provider_key}",
        detail={"provider_key": provider_key, "config": out},
    )
    return out


@router.delete("/{provider_key}")
async def delete_or_reset_provider(
    provider_key: str = Path(..., min_length=2, max_length=64, pattern=r"^[a-z0-9_-]+$"),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Delete a custom provider, or reset a catalog provider to defaults."""
    async with async_session() as session:
        result = await session.execute(select(ProviderConfig).where(ProviderConfig.provider_key == provider_key))
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(404, "No config exists for this provider")

        if row.is_custom:
            await session.delete(row)
            action = "provider_governance.delete"
            summary = f"Deleted custom provider '{provider_key}'"
        else:
            row.enabled = True
            row.default_max_tokens = 8192
            row.default_temperature = 0.1
            row.allowed_roles = None
            row.policies = None
            row.notes = ""
            row.default_endpoint = None
            row.label = None
            row.route_prefix = None
            row.api_key_env = None
            row.needs_endpoint = None
            row.placeholder = None
            row.is_local = None
            action = "provider_governance.reset"
            summary = f"Reset provider config for {provider_key} to catalog defaults"

        await session.commit()

    await record_admin_audit(
        user=_user,
        action=action,
        status="success",
        summary=summary,
        detail={"provider_key": provider_key},
    )
    return {"ok": True, "provider_key": provider_key}
