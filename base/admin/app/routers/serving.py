"""Model Serving Management API — curated service entries and health views."""

from __future__ import annotations

import logging
import time

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import ServingEndpoint
from ..rbac import require_platform_admin
from ..services.admin_audit import record_admin_audit

logger = logging.getLogger("synesis.admin.serving")

router = APIRouter(prefix="/api/v1/serving", tags=["serving"])


def _row_to_dict(row: ServingEndpoint) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "provider": row.provider,
        "model": row.model,
        "endpoint_url": row.endpoint_url,
        "api_key_env": row.api_key_env,
        "allowed_roles": row.allowed_roles,
        "is_active": row.is_active,
        "notes": row.notes,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.get("/endpoints")
async def list_endpoints(_user: UserInfo = Depends(get_current_user)):
    """List all curated serving endpoints."""
    async with async_session() as session:
        result = await session.execute(
            select(ServingEndpoint).order_by(ServingEndpoint.name)
        )
        rows = result.scalars().all()
    return {"endpoints": [_row_to_dict(r) for r in rows]}


@router.get("/endpoints/{endpoint_id}")
async def get_endpoint(endpoint_id: int, _user: UserInfo = Depends(get_current_user)):
    """Get a single serving endpoint by ID."""
    async with async_session() as session:
        result = await session.execute(
            select(ServingEndpoint).where(ServingEndpoint.id == endpoint_id)
        )
        row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Serving endpoint not found")
    return _row_to_dict(row)


@router.post("/endpoints")
async def create_endpoint(
    data: dict = Body(...),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Create a new curated serving endpoint."""
    name = (data.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    provider = (data.get("provider") or "").strip()
    model = (data.get("model") or "").strip()
    if not provider or not model:
        raise HTTPException(400, "provider and model are required")

    async with async_session() as session:
        existing = await session.execute(
            select(ServingEndpoint).where(ServingEndpoint.name == name)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(409, f"Serving endpoint '{name}' already exists")

        row = ServingEndpoint(
            name=name,
            provider=provider,
            model=model,
            endpoint_url=data.get("endpoint_url", ""),
            api_key_env=data.get("api_key_env", ""),
            allowed_roles=data.get("allowed_roles"),
            is_active=data.get("is_active", True),
            notes=data.get("notes", ""),
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        out = _row_to_dict(row)

    await record_admin_audit(
        user=_user,
        action="serving.create",
        status="success",
        summary=f"Created serving endpoint '{name}'",
        detail=out,
    )
    return out


@router.put("/endpoints/{endpoint_id}")
async def update_endpoint(
    endpoint_id: int,
    data: dict = Body(...),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Update a curated serving endpoint."""
    async with async_session() as session:
        result = await session.execute(
            select(ServingEndpoint).where(ServingEndpoint.id == endpoint_id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(404, "Serving endpoint not found")

        for field in ("name", "provider", "model", "endpoint_url", "api_key_env", "notes"):
            if field in data:
                setattr(row, field, data[field])
        if "allowed_roles" in data:
            row.allowed_roles = data["allowed_roles"] if data["allowed_roles"] else None
        if "is_active" in data:
            row.is_active = bool(data["is_active"])

        await session.commit()
        await session.refresh(row)
        out = _row_to_dict(row)

    await record_admin_audit(
        user=_user,
        action="serving.update",
        status="success",
        summary=f"Updated serving endpoint id={endpoint_id}",
        detail=out,
    )
    return out


@router.delete("/endpoints/{endpoint_id}")
async def delete_endpoint(
    endpoint_id: int,
    _user: UserInfo = Depends(require_platform_admin),
):
    """Delete a curated serving endpoint."""
    async with async_session() as session:
        result = await session.execute(
            select(ServingEndpoint).where(ServingEndpoint.id == endpoint_id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(404, "Serving endpoint not found")
        name = row.name
        await session.delete(row)
        await session.commit()

    await record_admin_audit(
        user=_user,
        action="serving.delete",
        status="success",
        summary=f"Deleted serving endpoint '{name}'",
        detail={"id": endpoint_id, "name": name},
    )
    return {"ok": True, "id": endpoint_id}


@router.get("/health")
async def serving_health(_user: UserInfo = Depends(get_current_user)):
    """Probe health of all active serving endpoints."""
    async with async_session() as session:
        result = await session.execute(
            select(ServingEndpoint).where(ServingEndpoint.is_active == True)  # noqa: E712
        )
        rows = result.scalars().all()

    checks: list[dict] = []
    async with httpx.AsyncClient(timeout=5.0) as client:
        for row in rows:
            url = (row.endpoint_url or "").strip()
            if not url:
                checks.append({
                    "id": row.id,
                    "name": row.name,
                    "provider": row.provider,
                    "model": row.model,
                    "reachable": False,
                    "status_code": None,
                    "latency_ms": None,
                    "error": "no endpoint URL configured",
                })
                continue
            health_url = url.rstrip("/") + "/health"
            started = time.time()
            try:
                resp = await client.get(health_url)
                checks.append({
                    "id": row.id,
                    "name": row.name,
                    "provider": row.provider,
                    "model": row.model,
                    "reachable": 200 <= resp.status_code < 500,
                    "status_code": resp.status_code,
                    "latency_ms": int((time.time() - started) * 1000),
                    "error": "",
                })
            except Exception as exc:
                checks.append({
                    "id": row.id,
                    "name": row.name,
                    "provider": row.provider,
                    "model": row.model,
                    "reachable": False,
                    "status_code": None,
                    "latency_ms": None,
                    "error": str(exc)[:180],
                })
    return {"endpoints": checks}
