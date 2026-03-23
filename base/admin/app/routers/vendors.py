"""Vendor Management API — provider governance, defaults, enablement."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import ProviderConfig
from ..rbac import require_platform_admin
from ..services.admin_audit import record_admin_audit
from ..services.provider_catalog import PROVIDER_CATALOG, get_catalog

logger = logging.getLogger("synesis.admin.vendors")

router = APIRouter(prefix="/api/v1/vendors", tags=["vendors"])


async def seed_vendor_configs() -> int:
    """Ensure every catalog provider has a ProviderConfig row.

    Runs on startup so Vendor Management is the single source of truth for
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


async def get_disabled_vendor_keys() -> frozenset[str]:
    """Return the set of provider keys that are disabled in vendor management."""
    async with async_session() as session:
        result = await session.execute(
            select(ProviderConfig.provider_key).where(ProviderConfig.enabled == False)
        )
        return frozenset(row[0] for row in result.all())


async def _get_all_configs() -> dict[str, dict]:
    """Load all ProviderConfig rows, keyed by provider_key."""
    async with async_session() as session:
        result = await session.execute(select(ProviderConfig))
        rows = result.scalars().all()
    return {
        r.provider_key: {
            "id": r.id,
            "provider_key": r.provider_key,
            "enabled": r.enabled,
            "default_max_tokens": r.default_max_tokens,
            "default_temperature": r.default_temperature,
            "allowed_roles": r.allowed_roles,
            "policies": r.policies,
            "notes": r.notes,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        }
        for r in rows
    }


@router.get("/")
async def list_vendors(_user: UserInfo = Depends(get_current_user)):
    """Return all providers from the catalog with their governance config overlay."""
    catalog = get_catalog()
    configs = await _get_all_configs()

    vendors = []
    for key, info in catalog["providers"].items():
        cfg = configs.get(key, {})
        vendors.append(
            {
                **info,
                "config": cfg if cfg else None,
                "enabled": cfg.get("enabled", True),
                "default_max_tokens": cfg.get("default_max_tokens", 8192),
                "default_temperature": cfg.get("default_temperature", 0.1),
                "allowed_roles": cfg.get("allowed_roles"),
                "policies": cfg.get("policies"),
                "notes": cfg.get("notes", ""),
                "config_updated_at": cfg.get("updated_at"),
            }
        )
    return {"vendors": vendors}


@router.get("/{provider_key}")
async def get_vendor(provider_key: str, _user: UserInfo = Depends(get_current_user)):
    """Get a single vendor's catalog info + governance config."""
    if provider_key not in PROVIDER_CATALOG:
        raise HTTPException(404, f"Unknown provider: {provider_key}")
    catalog = get_catalog()
    info = catalog["providers"][provider_key]
    configs = await _get_all_configs()
    cfg = configs.get(provider_key, {})
    return {
        **info,
        "config": cfg if cfg else None,
        "enabled": cfg.get("enabled", True),
        "default_max_tokens": cfg.get("default_max_tokens", 8192),
        "default_temperature": cfg.get("default_temperature", 0.1),
        "allowed_roles": cfg.get("allowed_roles"),
        "policies": cfg.get("policies"),
        "notes": cfg.get("notes", ""),
    }


@router.put("/{provider_key}")
async def update_vendor(
    provider_key: str,
    data: dict = Body(...),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Create or update governance config for a provider."""
    if provider_key not in PROVIDER_CATALOG:
        raise HTTPException(404, f"Unknown provider: {provider_key}")

    async with async_session() as session:
        result = await session.execute(select(ProviderConfig).where(ProviderConfig.provider_key == provider_key))
        row = result.scalar_one_or_none()
        if row is None:
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

        await session.commit()
        await session.refresh(row)

        out = {
            "id": row.id,
            "provider_key": row.provider_key,
            "enabled": row.enabled,
            "default_max_tokens": row.default_max_tokens,
            "default_temperature": row.default_temperature,
            "allowed_roles": row.allowed_roles,
            "policies": row.policies,
            "notes": row.notes,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }

    await record_admin_audit(
        user=_user,
        action="vendors.update",
        status="success",
        summary=f"Updated vendor config for {provider_key}",
        detail={"provider_key": provider_key, "config": out},
    )
    return out


@router.delete("/{provider_key}")
async def reset_vendor(
    provider_key: str,
    _user: UserInfo = Depends(require_platform_admin),
):
    """Reset vendor config to catalog defaults (keep the row, restore defaults)."""
    async with async_session() as session:
        result = await session.execute(select(ProviderConfig).where(ProviderConfig.provider_key == provider_key))
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(404, "No config exists for this provider")
        row.enabled = True
        row.default_max_tokens = 8192
        row.default_temperature = 0.1
        row.allowed_roles = None
        row.policies = None
        row.notes = ""
        await session.commit()

    await record_admin_audit(
        user=_user,
        action="vendors.reset",
        status="success",
        summary=f"Reset vendor config for {provider_key} to catalog defaults",
        detail={"provider_key": provider_key},
    )
    return {"ok": True, "provider_key": provider_key}
