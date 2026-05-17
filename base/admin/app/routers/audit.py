"""Admin audit log — rolling history of operator actions and runtime propagation."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from ..auth import UserInfo, require_admin
from ..db.engine import async_session
from ..db.models import AdminAuditEvent

router = APIRouter(prefix="/api/v1/audit", tags=["audit"])


@router.get("/events")
async def list_audit_events(
    _user: UserInfo = Depends(require_admin),
    limit: int = Query(100, ge=1, le=500),
    before_id: int | None = Query(None, description="Pagination: return rows with id < before_id"),
):
    """Newest-first audit stream (model changes, provider keys, route refreshes, etc.)."""
    async with async_session() as session:
        q = select(AdminAuditEvent)
        if before_id is not None:
            q = q.where(AdminAuditEvent.id < before_id)
        q = q.order_by(AdminAuditEvent.id.desc()).limit(limit)
        result = await session.execute(q)
        rows = result.scalars().all()
    return {
        "events": [
            {
                "id": r.id,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "source": r.source,
                "actor_username": r.actor_username,
                "actor_user_id": r.actor_user_id,
                "actor_role": r.actor_role,
                "action": r.action,
                "status": r.status,
                "summary": r.summary,
                "detail": r.detail or {},
            }
            for r in rows
        ],
    }
