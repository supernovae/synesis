"""Discovered Conflict Groups — HITL review for intent anchor resolution."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select, update

from ..auth import UserInfo, get_current_user, require_admin
from ..db.engine import async_session
from ..db.models import DiscoveredConflictGroup

router = APIRouter(prefix="/api/v1/pipeline/conflict-groups", tags=["pipeline"])


class ReviewRequest(BaseModel):
    status: str  # "approved" or "rejected"
    reviewer_note: str = ""
    group_name: str | None = None
    members: list[str] | None = None
    default_pick: str | None = None


@router.get("")
async def list_conflict_groups(
    status: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _user: UserInfo = Depends(get_current_user),
):
    async with async_session() as session:
        q = select(DiscoveredConflictGroup).order_by(DiscoveredConflictGroup.discovered_at.desc())
        if status:
            q = q.where(DiscoveredConflictGroup.status == status)
        q = q.offset(offset).limit(limit)

        result = await session.execute(q)
        rows = result.scalars().all()

        count_q = select(func.count(DiscoveredConflictGroup.id))
        if status:
            count_q = count_q.where(DiscoveredConflictGroup.status == status)
        total = (await session.execute(count_q)).scalar() or 0

    groups = [
        {
            "id": r.id,
            "group_name": r.group_name,
            "members": r.members,
            "default_pick": r.default_pick or "",
            "exclusion_map": r.exclusion_map or {},
            "source_query": r.source_query or "",
            "source_run_id": r.source_run_id or "",
            "status": r.status,
            "reviewer_note": r.reviewer_note or "",
            "discovered_at": r.discovered_at.isoformat() if r.discovered_at else "",
            "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else "",
        }
        for r in rows
    ]
    return {"groups": groups, "total": total}


@router.get("/stats")
async def conflict_group_stats(_user: UserInfo = Depends(get_current_user)):
    async with async_session() as session:
        total = (await session.execute(select(func.count(DiscoveredConflictGroup.id)))).scalar() or 0
        pending = (
            await session.execute(
                select(func.count(DiscoveredConflictGroup.id)).where(DiscoveredConflictGroup.status == "pending_review")
            )
        ).scalar() or 0
        approved = (
            await session.execute(
                select(func.count(DiscoveredConflictGroup.id)).where(DiscoveredConflictGroup.status == "approved")
            )
        ).scalar() or 0
        rejected = (
            await session.execute(
                select(func.count(DiscoveredConflictGroup.id)).where(DiscoveredConflictGroup.status == "rejected")
            )
        ).scalar() or 0

    return {
        "total": total,
        "pending_review": pending,
        "approved": approved,
        "rejected": rejected,
    }


@router.post("/{group_id}/review")
async def review_conflict_group(
    group_id: int,
    body: ReviewRequest,
    _user: UserInfo = Depends(require_admin),
):
    if body.status not in ("approved", "rejected"):
        raise HTTPException(400, "status must be 'approved' or 'rejected'")

    async with async_session() as session:
        row = await session.get(DiscoveredConflictGroup, group_id)
        if not row:
            raise HTTPException(404, "Conflict group not found")

        values: dict = {
            "status": body.status,
            "reviewer_note": body.reviewer_note,
            "reviewed_at": datetime.now(UTC),
        }
        if body.group_name is not None:
            values["group_name"] = body.group_name
        if body.members is not None:
            values["members"] = body.members
            exclusion_map = {}
            for m in body.members:
                exclusion_map[m.lower()] = [o.lower() for o in body.members if o.lower() != m.lower()]
            values["exclusion_map"] = exclusion_map
        if body.default_pick is not None:
            values["default_pick"] = body.default_pick

        await session.execute(
            update(DiscoveredConflictGroup).where(DiscoveredConflictGroup.id == group_id).values(**values)
        )
        await session.commit()

    return {"status": "ok", "group_id": group_id, "new_status": body.status}


@router.delete("/{group_id}")
async def delete_conflict_group(
    group_id: int,
    _user: UserInfo = Depends(require_admin),
):
    async with async_session() as session:
        row = await session.get(DiscoveredConflictGroup, group_id)
        if not row:
            raise HTTPException(404, "Conflict group not found")
        await session.delete(row)
        await session.commit()

    return {"status": "deleted", "group_id": group_id}
