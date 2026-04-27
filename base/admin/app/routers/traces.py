"""Trace browsing: list, detail, aggregate statistics, and pipeline test.

All read routes require ``org_observability`` (org_admin+ with org, or platform_admin).
End-user billing totals should use ``/api/v1/usage/me/summary`` (planner_usage_log), not traces.
"""

import asyncio
import logging
import time

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request

from ..auth import UserInfo, get_current_user
from ..deps import INTERNAL_SERVICE_TOKEN, PLANNER_URL
from ..rbac import RouteGroup, can_access_route_group, can_access_trace, require_platform_admin, trace_scope_filters
from ..services import trace_store

logger = logging.getLogger("synesis.admin.traces")

router = APIRouter(prefix="/api/v1/traces", tags=["traces"])


def _ensure_org_observability(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_observability):
        raise HTTPException(status_code=403, detail="Requires route group access: org_observability")


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
    decision_path: str = Query(
        "", description="Filter by decision routing path (deterministic, constrained, inference_first, abstain)"
    ),
    tenant_id: str = Query("", description="Filter by tenant"),
    trace_service: str = Query(
        "",
        description="Filter by emitter: planner (default all non-yarn), yarn, or all",
    ),
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_observability(_user)
    scope = trace_scope_filters(_user)
    effective_tenant = tenant_id or scope.get("scope_tenant_id", "")
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
        decision_path=decision_path,
        scope_user_id=scope.get("user_id", ""),
        scope_org_id=scope.get("org_id", ""),
        scope_tenant_id=effective_tenant,
        trace_service=trace_service,
    )


@router.get("/stats")
async def trace_stats(_user: UserInfo = Depends(get_current_user)):
    _ensure_org_observability(_user)
    scope = trace_scope_filters(_user)
    return await trace_store.get_trace_stats(
        scope_user_id=scope.get("user_id", ""),
        scope_org_id=scope.get("org_id", ""),
        scope_tenant_id=scope.get("scope_tenant_id", ""),
    )


@router.get("/analytics")
async def trace_decision_analytics(
    since: float = Query(0, description="Unix timestamp start (default: 24h ago)"),
    until: float = Query(0, description="Unix timestamp end (default: now)"),
    org_id: str = Query("", description="Filter by org"),
    _user: UserInfo = Depends(get_current_user),
):
    """Decision-path, recall, and verification analytics aggregated from trace JSONB."""
    _ensure_org_observability(_user)
    scope = trace_scope_filters(_user)
    effective_org = org_id or scope.get("org_id", "")
    return await trace_store.get_decision_analytics(
        since=since,
        until=until,
        scope_org_id=effective_org,
        scope_tenant_id=scope.get("scope_tenant_id", ""),
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


def _verify_service_token(request: Request) -> None:
    """Verify the internal service token for service-to-service calls."""
    if not INTERNAL_SERVICE_TOKEN:
        return
    token = (
        request.headers.get("x-synesis-service-token", "")
        or request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    )
    if token != INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid service token")


@router.post("/ingest")
async def ingest_trace(request: Request, body: dict = Body(...)):
    """Accept a trace record from planner-ts or yarn-ts via fire-and-forget POST."""
    _verify_service_token(request)

    service = body.get("service", "unknown")
    trace_id = body.get("trace_id") or body.get("request_id", "")
    tokens = body.get("tokens", {})
    cost = body.get("cost", {})

    total_tokens = tokens.get("total_tokens", 0) or (
        tokens.get("prompt_tokens", 0) + tokens.get("completion_tokens", 0)
    )

    classification = body.get("classification") or {}
    difficulty = body.get("difficulty") or classification.get("difficulty", 0)
    task_type = body.get("task_type") or classification.get("taxonomy_key", "")
    is_code = body.get("is_code_task", False)
    if not is_code and isinstance(task_type, str):
        is_code = task_type.startswith("code") or "programming" in task_type
    has_error = bool(body.get("error") or body.get("has_error", False))
    iteration_count = body.get("iteration_count", 0) or 0

    trace_data = {
        "trace_id": trace_id,
        "user_id": body.get("user_id", ""),
        "org_id": body.get("org_id", ""),
        "tenant_id": body.get("tenant_id", ""),
        "conversation_id": body.get("conversation_id", ""),
        "parent_trace_id": body.get("parent_trace_id", ""),
        "root_trace_id": body.get("root_trace_id", ""),
        "query_snippet": body.get("query_snippet", ""),
        "timestamp": body.get("timestamp", time.time()),
        "total_duration_ms": body.get("latency_ms", 0),
        "total_tokens": total_tokens,
        "estimated_cost_usd": cost.get("estimated_usd", 0),
        "actual_cost_usd": cost.get("actual_usd", 0),
        "difficulty": difficulty,
        "task_type": task_type,
        "is_code_task": is_code,
        "has_error": has_error,
        "iteration_count": iteration_count,
        "full_record": body,
    }

    try:
        await trace_store.upsert_trace(trace_data)
        logger.info("trace_ingested service=%s trace_id=%s tokens=%d", service, trace_id, total_tokens)
    except Exception:
        logger.warning("trace_ingest_failed service=%s trace_id=%s", service, trace_id, exc_info=True)
        raise HTTPException(status_code=500, detail="Trace ingestion failed")

    return {"status": "ok", "trace_id": trace_id}


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
    _ensure_org_observability(_user)
    record = await trace_store.get_trace(trace_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    if not can_access_trace(_user, record):
        raise HTTPException(status_code=403, detail="Not authorized to view this trace")
    _enrich_detail(record)
    return record


@router.get("/{trace_id}/chain")
async def get_trace_chain(
    trace_id: str,
    limit: int = Query(200, ge=1, le=1000),
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_observability(_user)
    data = await trace_store.get_trace_chain(trace_id, limit=limit)
    if data is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    filtered = [row for row in data.get("chain", []) if can_access_trace(_user, row)]
    return {
        "trace_id": data.get("trace_id", trace_id),
        "root_trace_id": data.get("root_trace_id"),
        "conversation_id": data.get("conversation_id"),
        "chain": filtered,
    }


def _enrich_detail(record: dict) -> None:
    """Promote enriched decision fields from full_record to top level for the detail view."""
    for key in (
        "evidence_summary",
        "decision_ledger",
        "trace_context",
        "streaming",
        "taxonomy",
        "optimization_ledger",
    ):
        if key not in record and key in record.get("full_record", {}):
            record[key] = record["full_record"][key]
    ledger = record.get("decision_ledger")
    if isinstance(ledger, list) and ledger:
        entry = ledger[0]
        if isinstance(entry, dict):
            record.setdefault("decision_path", entry.get("path"))
            record.setdefault("decision_escalated", entry.get("escalated"))

    tokens = record.get("tokens")
    if not isinstance(tokens, dict):
        fr = record.get("full_record")
        if isinstance(fr, dict) and isinstance(fr.get("tokens"), dict):
            tokens = fr["tokens"]
            record.setdefault("tokens", tokens)
    if isinstance(tokens, dict):
        prompt_in = int(tokens.get("prompt_tokens", 0) or 0)
        cached = int(tokens.get("cached_prompt_tokens", 0) or 0)
        cache_write = int(tokens.get("cache_creation_tokens", 0) or 0)
        completion_in = int(tokens.get("completion_tokens", 0) or 0)
        # Always surface provider-reported cache fields (including zeros) for trace UI / waste detection.
        record["total_cached_prompt_tokens"] = cached
        record["total_cache_creation_tokens"] = cache_write
        record["total_prompt_tokens_reported"] = prompt_in
        record["total_completion_tokens_reported"] = completion_in
        if prompt_in > 0:
            record["prompt_cache_hit_ratio"] = round(cached / prompt_in, 6)
        else:
            record["prompt_cache_hit_ratio"] = None

    opt = record.get("optimization_ledger")
    if isinstance(opt, dict):
        saved = int(opt.get("estimatedTokensSaved", 0) or 0)
        if saved > 0:
            record.setdefault("tokens_saved_by_optimization", saved)
        pipeline_ms = int(opt.get("pipelineLatencyMs", 0) or 0)
        if pipeline_ms > 0:
            record.setdefault("optimization_pipeline_ms", pipeline_ms)
