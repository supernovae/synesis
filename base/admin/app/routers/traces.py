"""Trace browsing: list, detail, aggregate statistics, and pipeline test."""

import asyncio
import logging
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import UserInfo, get_current_user, require_admin
from ..deps import PLANNER_URL
from ..services import trace_store

logger = logging.getLogger("synesis.admin.traces")

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


@router.post("/test")
async def test_trace_pipeline(_user: UserInfo = Depends(require_admin)):
    """Send a test query to the planner and verify a trace appears in Postgres."""
    test_query = "What is 2+2? (synesis admin trace test)"
    t0 = time.time()

    # Send a minimal chat completion request to the planner
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
        return {
            "status": "fail",
            "stage": "planner_request",
            "error": str(exc)[:200],
            "elapsed_ms": round((time.time() - t0) * 1000),
        }

    if not planner_ok:
        return {
            "status": "fail",
            "stage": "planner_response",
            "error": f"HTTP {planner_status}",
            "elapsed_ms": round((time.time() - t0) * 1000),
        }

    # Poll for the trace in Postgres (planner flushes on request completion)
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


@router.get("/{trace_id}")
async def get_trace(trace_id: str, _user: UserInfo = Depends(get_current_user)):
    record = await trace_store.get_trace(trace_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    return record
