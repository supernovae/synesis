"""Effective Serving — read-only view derived from Model Registry role assignments."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy import select

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import ModelDeployment

logger = logging.getLogger("synesis.admin.serving")

router = APIRouter(prefix="/api/v1/serving", tags=["serving"])


@router.get("/effective")
async def effective_serving(_user: UserInfo = Depends(get_current_user)):
    """Derive the effective serving map from active Model Registry role assignments.

    This replaces the old CRUD serving endpoints.  The Model Registry is the
    single source of truth — this view is always read-only.
    """
    async with async_session() as session:
        result = await session.execute(
            select(ModelDeployment).where(ModelDeployment.is_active == True).order_by(ModelDeployment.role)
        )
        rows = result.scalars().all()

    entries = []
    for r in rows:
        entries.append(
            {
                "id": r.id,
                "role": r.role,
                "served_name": r.served_name,
                "provider": r.provider or "",
                "model": r.model,
                "endpoint": r.endpoint,
                "api_key_env": r.api_key_env or "",
                "status": r.status,
                "source": r.source,
                "is_active": r.is_active,
                "description": r.description,
                "notes": r.notes,
                "fallbacks": r.fallbacks,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
        )
    return {"entries": entries, "source": "model_registry"}
