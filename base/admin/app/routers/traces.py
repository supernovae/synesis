"""Trace browsing: list, detail, and aggregate statistics."""

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import UserInfo, get_current_user
from ..services import trace_store

router = APIRouter(prefix="/api/v1/traces", tags=["traces"])


@router.get("")
async def list_traces(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    has_error: bool | None = None,
    user_id: str = "",
    task_type: str = "",
    min_difficulty: float | None = None,
    max_difficulty: float | None = None,
    domain_tag: str = "",
    since: float = 0,
    until: float = 0,
    _user: UserInfo = Depends(get_current_user),
):
    return await trace_store.list_traces(
        offset=offset,
        limit=limit,
        has_error=has_error,
        user_id=user_id,
        task_type=task_type,
        min_difficulty=min_difficulty,
        max_difficulty=max_difficulty,
        domain_tag=domain_tag,
        since=since,
        until=until,
    )


@router.get("/stats")
async def trace_stats(_user: UserInfo = Depends(get_current_user)):
    return await trace_store.get_trace_stats()


@router.get("/{trace_id}")
async def get_trace(trace_id: str, _user: UserInfo = Depends(get_current_user)):
    record = await trace_store.get_trace(trace_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    return record
