"""Validation and CRUD for public model offerings (client-facing model ids)."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ModelPublicOffering
from .public_model_offerings_rules import (
    normalize_route_and_effort,
    validate_client_model_id,
)

__all__ = [
    "list_offerings",
    "list_offerings_for_service",
    "get_offering_by_id",
    "create_offering",
    "update_offering",
    "delete_offering",
]


def row_to_api(row: ModelPublicOffering) -> dict[str, Any]:
    return {
        "id": row.id,
        "client_model_id": row.client_model_id,
        "label": row.label,
        "effort_tier": row.effort_tier,
        "route_via_role": row.route_via_role,
        "backend_model_override": row.backend_model_override,
        "expose_planner": row.expose_planner,
        "expose_yarn": row.expose_yarn,
        "is_active": row.is_active,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def list_offerings(session: AsyncSession, *, active_only: bool = False) -> list[dict[str, Any]]:
    stmt = select(ModelPublicOffering).order_by(ModelPublicOffering.client_model_id)
    if active_only:
        stmt = stmt.where(ModelPublicOffering.is_active.is_(True))
    result = await session.execute(stmt)
    return [row_to_api(r) for r in result.scalars().all()]


async def list_offerings_for_service(
    session: AsyncSession, *, for_service: str
) -> list[dict[str, Any]]:
    """for_service: 'yarn' | 'planner' — active rows with matching expose flag."""
    stmt = select(ModelPublicOffering).where(ModelPublicOffering.is_active.is_(True))
    if for_service == "yarn":
        stmt = stmt.where(ModelPublicOffering.expose_yarn.is_(True))
    elif for_service == "planner":
        stmt = stmt.where(ModelPublicOffering.expose_planner.is_(True))
    else:
        raise ValueError("for_service must be 'yarn' or 'planner'")
    stmt = stmt.order_by(ModelPublicOffering.client_model_id)
    result = await session.execute(stmt)
    return [row_to_api(r) for r in result.scalars().all()]


async def get_offering_by_id(session: AsyncSession, offering_id: int) -> ModelPublicOffering | None:
    result = await session.execute(select(ModelPublicOffering).where(ModelPublicOffering.id == offering_id))
    return result.scalar_one_or_none()


async def create_offering(
    session: AsyncSession,
    *,
    client_model_id: str,
    label: str | None,
    effort_tier: str | None,
    route_via_role: str | None,
    backend_model_override: str | None,
    expose_planner: bool,
    expose_yarn: bool,
    is_active: bool = True,
) -> dict[str, Any]:
    cid = validate_client_model_id(client_model_id)
    et, rv = normalize_route_and_effort(effort_tier, route_via_role)
    override = (backend_model_override or "").strip() or None
    row = ModelPublicOffering(
        client_model_id=cid,
        label=(label or "").strip() or None,
        effort_tier=et,
        route_via_role=rv,
        backend_model_override=override,
        expose_planner=bool(expose_planner),
        expose_yarn=bool(expose_yarn),
        is_active=bool(is_active),
    )
    session.add(row)
    await session.flush()
    await session.refresh(row)
    return row_to_api(row)


async def update_offering(
    session: AsyncSession,
    offering_id: int,
    patch: dict[str, Any],
) -> dict[str, Any] | None:
    row = await get_offering_by_id(session, offering_id)
    if row is None:
        return None
    if "client_model_id" in patch and patch["client_model_id"] is not None:
        row.client_model_id = validate_client_model_id(str(patch["client_model_id"]))
    if "label" in patch:
        v = patch["label"]
        row.label = (str(v).strip() or None) if v is not None else None
    if "effort_tier" in patch or "route_via_role" in patch:
        et_guess = patch["effort_tier"] if "effort_tier" in patch else row.effort_tier
        rv_guess = patch["route_via_role"] if "route_via_role" in patch else row.route_via_role
        et, rv = normalize_route_and_effort(
            str(et_guess) if et_guess is not None else None,
            str(rv_guess) if rv_guess is not None else None,
        )
        row.effort_tier = et
        row.route_via_role = rv
    if "backend_model_override" in patch:
        v = patch["backend_model_override"]
        if v is None:
            row.backend_model_override = None
        else:
            row.backend_model_override = str(v).strip() or None
    if "expose_planner" in patch:
        row.expose_planner = bool(patch["expose_planner"])
    if "expose_yarn" in patch:
        row.expose_yarn = bool(patch["expose_yarn"])
    if "is_active" in patch:
        row.is_active = bool(patch["is_active"])
    await session.flush()
    await session.refresh(row)
    return row_to_api(row)


async def delete_offering(session: AsyncSession, offering_id: int) -> bool:
    row = await get_offering_by_id(session, offering_id)
    if row is None:
        return False
    await session.delete(row)
    return True
