"""Trace browsing: list, detail, aggregate statistics, and pipeline test."""

import asyncio
import logging
import time

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query

from ..auth import UserInfo, get_current_user
from ..deps import PLANNER_URL
from ..rbac import can_access_trace, require_platform_admin, trace_scope_filters
from ..services import trace_store

logger = logging.getLogger("synesis.admin.traces")

router = APIRouter(prefix="/api/v1/traces", tags=["traces"])


@router.get("")
async def list_traces(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    has_error: bool | None = None,
    user_id: str = "",
    user_email: str = "",
    org_id: str = "",
    task_type: str = "",
    min_difficulty: float | None = None,
    max_difficulty: float | None = None,
    domain_tag: str = "",
    conversation_id: str = "",
    since: float = 0,
    until: float = 0,
    max_tokens: int | None = None,
    min_hallucinated_urls: int | None = Query(
        None, ge=1, description="Filter traces with at least N hallucinated URLs"
    ),
    _user: UserInfo = Depends(get_current_user),
):
    scope = trace_scope_filters(_user)
    return await trace_store.list_traces(
        offset=offset,
        limit=limit,
        has_error=has_error,
        user_id=user_id,
        user_email=user_email,
        org_id=org_id,
        conversation_id=conversation_id,
        task_type=task_type,
        min_difficulty=min_difficulty,
        max_difficulty=max_difficulty,
        domain_tag=domain_tag,
        since=since,
        until=until,
        max_tokens=max_tokens,
        min_hallucinated_urls=min_hallucinated_urls,
        scope_user_id=scope.get("user_id", ""),
        scope_org_id=scope.get("org_id", ""),
    )


@router.get("/stats")
async def trace_stats(_user: UserInfo = Depends(get_current_user)):
    scope = trace_scope_filters(_user)
    return await trace_store.get_trace_stats(
        scope_user_id=scope.get("user_id", ""),
        scope_org_id=scope.get("org_id", ""),
    )


@router.post("/test")
async def test_trace_pipeline(_user: UserInfo = Depends(require_platform_admin)):
    """Send a test query to the planner and verify a trace appears in Postgres."""
    test_query = "What is 2+2? (synesis admin trace test)"
    t0 = time.time()

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{PLANNER_URL.rstrip('/')}/v1/chat/completions",
                json={
                    "model": "synesis-agent",
                    "messages": [{"role": "user", "content": test_query}],
                    "max_tokens": 64,
                    "stream": False,
                },
            )
            planner_status = resp.status_code
            planner_ok = planner_status < 500
    except Exception as exc:
        logger.warning("trace_test_planner_request_failed", exc_info=True)
        return {
            "status": "fail",
            "stage": "planner_request",
            "error": type(exc).__name__,
            "elapsed_ms": round((time.time() - t0) * 1000),
        }

    if not planner_ok:
        return {
            "status": "fail",
            "stage": "planner_response",
            "error": f"HTTP {planner_status}",
            "elapsed_ms": round((time.time() - t0) * 1000),
        }

    trace_found = None
    for _ in range(6):
        await asyncio.sleep(2)
        result = await trace_store.list_traces(since=t0, limit=5)
        for tr in result.get("traces", []):
            snippet = tr.get("query_snippet", "")
            if "synesis admin trace test" in snippet:
                trace_found = tr
                break
        if trace_found:
            break

    elapsed = round((time.time() - t0) * 1000)

    if trace_found:
        return {
            "status": "pass",
            "trace_id": trace_found.get("trace_id"),
            "total_tokens": trace_found.get("total_tokens", 0),
            "duration_ms": trace_found.get("total_duration_ms", 0),
            "estimated_cost_usd": trace_found.get("estimated_cost_usd", 0),
            "elapsed_ms": elapsed,
        }

    return {
        "status": "fail",
        "stage": "trace_lookup",
        "error": "Trace not found in Postgres after 12s",
        "planner_status": planner_status,
        "elapsed_ms": elapsed,
    }


@router.delete("/{trace_id}")
async def delete_trace(trace_id: str, _user: UserInfo = Depends(require_platform_admin)):
    """Delete a single trace by ID."""
    from sqlalchemy import text as sa_text

    from ..db.engine import async_session as db_session

    async with db_session() as session:
        result = await session.execute(sa_text("DELETE FROM traces WHERE trace_id = :tid"), {"tid": trace_id})
        await session.commit()
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Trace not found")
    return {"deleted": trace_id}


_BULK_DELETE_MAX = 500


@router.post("/bulk-delete")
async def bulk_delete_traces(
    trace_ids: list[str] = Body(..., min_length=1, max_length=_BULK_DELETE_MAX),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Delete multiple traces by their IDs (max 500 per call)."""
    from sqlalchemy import text as sa_text

    from ..db.engine import async_session as db_session

    async with db_session() as session:
        result = await session.execute(
            sa_text("DELETE FROM traces WHERE trace_id = ANY(:ids)"),
            {"ids": trace_ids},
        )
        await session.commit()
    return {"deleted": result.rowcount, "requested": len(trace_ids)}


@router.delete("/session/{conversation_id}")
async def delete_traces_for_session(
    conversation_id: str,
    _user: UserInfo = Depends(require_platform_admin),
):
    """Delete all traces belonging to one conversation/session."""
    n = await trace_store.delete_traces_for_conversation(conversation_id)
    return {"deleted": n, "conversation_id": conversation_id}


@router.post("/purge-trivial")
async def purge_trivial_traces(
    min_tokens: int = Query(50, ge=1),
    dry_run: bool = Query(True),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Purge traces with very low token counts (test/trivial prompts).

    Default dry_run=True only counts; set dry_run=False to actually delete.
    """
    from sqlalchemy import text as sa_text

    from ..db.engine import async_session as db_session

    async with db_session() as session:
        count_row = (
            await session.execute(
                sa_text("SELECT COUNT(*)::int AS cnt FROM traces WHERE total_tokens < :min"),
                {"min": min_tokens},
            )
        ).one()
        count = count_row.cnt

        if dry_run or count == 0:
            return {"would_delete": count, "dry_run": True, "min_tokens": min_tokens}

        await session.execute(sa_text("DELETE FROM traces WHERE total_tokens < :min"), {"min": min_tokens})
        await session.commit()
    return {"deleted": count, "dry_run": False, "min_tokens": min_tokens}


@router.get("/{trace_id}")
async def get_trace(trace_id: str, _user: UserInfo = Depends(get_current_user)):
    record = await trace_store.get_trace(trace_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    if not can_access_trace(_user, record):
        raise HTTPException(status_code=403, detail="Not authorized to view this trace")
    return record
