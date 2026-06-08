"""Trace browsing: list, detail, aggregate statistics, and pipeline test.

All read routes require ``org_observability`` (org_admin+ with org, or platform_admin).
End-user billing totals should use ``/api/v1/usage/me/summary`` (planner_usage_log), not traces.
"""

import asyncio
import logging
import time
from typing import Any, Literal, Self

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..auth import UserInfo, get_current_user
from ..deps import PLANNER_URL
from ..internal_auth import require_internal_service_token_request
from ..rbac import RouteGroup, can_access_route_group, can_access_trace, require_platform_admin, trace_scope_filters
from ..services import trace_store
from ..services.archive_store import ArchiveConfigError

logger = logging.getLogger("synesis.admin.traces")

router = APIRouter(prefix="/api/v1/traces", tags=["traces"])


class TraceArchiveRequest(BaseModel):
    trace_ids: list[str] = Field(default_factory=list, max_length=500)
    older_than_days: int | None = Field(default=None, ge=1, le=3650)
    trace_service: str = Field(default="", max_length=32)
    dry_run: bool = True
    delete_after_archive: bool = False


class TraceTokensBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt_tokens: int = Field(0, ge=0, le=10_000_000_000)
    completion_tokens: int = Field(0, ge=0, le=10_000_000_000)
    total_tokens: int = Field(0, ge=0, le=10_000_000_000)
    cached_prompt_tokens: int = Field(0, ge=0, le=10_000_000_000)
    cache_creation_tokens: int | None = Field(None, ge=0, le=10_000_000_000)
    estimated_cost_usd: float | None = Field(None, ge=0, le=1_000_000_000)
    actual_cost_usd: float | None = Field(None, ge=0, le=1_000_000_000)


class TraceRatesSnapshotBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input_per_million: float = Field(0, ge=0, le=1_000_000)
    output_per_million: float = Field(0, ge=0, le=1_000_000)
    cached_input_per_million: float | None = Field(None, ge=0, le=1_000_000)
    cache_write_input_per_million: float | None = Field(None, ge=0, le=1_000_000)


class TraceCostBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    estimated_usd: float = Field(0, ge=0, le=1_000_000_000)
    actual_usd: float = Field(0, ge=0, le=1_000_000_000)
    rates_snapshot: TraceRatesSnapshotBody | None = None


class TraceClassificationBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    difficulty: float = Field(0, ge=0, le=1)
    task_size: str = Field("", max_length=64)
    risk_score: float = Field(0, ge=0, le=1)
    effort_mode: str = Field("", max_length=64)
    model_tier: str = Field("", max_length=64)
    rag_mode: str = Field("", max_length=64)
    plan_required: bool = False
    show_assumptions: bool = False
    taxonomy_key: str = Field("", max_length=128)
    cynefin_domain: Literal["clear", "complicated", "complex", "chaotic"] | None = None
    active_vertical: str | None = Field(None, max_length=128)


class TraceLlmCallBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    model: str = Field("", max_length=256)
    node: str = Field("", max_length=128)
    role: str | None = Field(None, max_length=64)
    prompt_tokens: int = Field(0, ge=0, le=10_000_000_000)
    completion_tokens: int = Field(0, ge=0, le=10_000_000_000)
    total_tokens: int = Field(0, ge=0, le=10_000_000_000)
    cached_prompt_tokens: int | None = Field(None, ge=0, le=10_000_000_000)
    latency_ms: float = Field(0, ge=0, le=86_400_000)
    prompt_snippet: str | None = Field(None, max_length=200000)
    completion_snippet: str | None = Field(None, max_length=200000)
    prompt_full: str | None = Field(None, max_length=500000)
    completion_full: str | None = Field(None, max_length=500000)
    timestamp: float = Field(default_factory=time.time, ge=0)
    actual_cost: float | None = Field(None, ge=0, le=1_000_000_000)
    estimated_cost: float | None = Field(None, ge=0, le=1_000_000_000)


class TraceSpanBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    node_name: str = Field("", max_length=128)
    intent: str | None = Field(None, max_length=128)
    start_time: float = Field(0, ge=0)
    end_time: float = Field(0, ge=0)
    latency_ms: float = Field(0, ge=0, le=86_400_000)
    tokens_used: int = Field(0, ge=0, le=10_000_000_000)
    confidence: float = Field(0, ge=0, le=1)
    outcome: str = Field("", max_length=128)
    reasoning: str | None = Field(None, max_length=20000)
    llm_calls: list[TraceLlmCallBody] = Field(default_factory=list, max_length=100)
    metadata: dict[str, Any] | None = Field(None, max_length=200)


class TraceStreamingBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["streaming", "non-streaming"]
    time_to_first_token_ms: float | None = Field(None, ge=0, le=86_400_000)


class TraceIngestBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    service: Literal["planner", "yarn", "unknown"] = "unknown"
    trace_id: str | None = Field(None, min_length=1, max_length=128)
    request_id: str | None = Field(None, min_length=1, max_length=128)
    authz_trace_id: str | None = Field(None, max_length=128)
    conversation_id: str = Field("", max_length=128)
    parent_trace_id: str = Field("", max_length=128)
    root_trace_id: str = Field("", max_length=128)
    timestamp: float = Field(default_factory=time.time, ge=0)
    user_id: str = Field("", max_length=256)
    org_id: str = Field("", max_length=256)
    tenant_id: str = Field("", max_length=64)
    model: str = Field("", max_length=256)
    tokens: TraceTokensBody = Field(default_factory=TraceTokensBody)
    cost: TraceCostBody = Field(default_factory=TraceCostBody)
    latency_ms: float = Field(0, ge=0, le=86_400_000)
    query_snippet: str = Field("", max_length=20000)
    spans: list[TraceSpanBody] = Field(default_factory=list, max_length=500)
    decision_ledger: list[Any] | None = Field(None, max_length=500)
    sensemaking: dict[str, Any] | None = Field(None, max_length=200)
    task_frame: dict[str, Any] | None = Field(None, max_length=200)
    critic_result: dict[str, Any] | None = Field(None, max_length=200)
    background_critic: dict[str, Any] | None = Field(None, max_length=200)
    classification: TraceClassificationBody | None = None
    difficulty: float | None = Field(None, ge=0, le=1)
    task_type: str | None = Field(None, max_length=128)
    domain_tags: list[str] | None = Field(None, max_length=100)
    is_code_task: bool = False
    has_error: bool = False
    iteration_count: int = Field(0, ge=0, le=1000000)
    max_iterations: int | None = Field(None, ge=0, le=1000000)
    phase_timings: dict[str, float] | None = Field(None, max_length=100)
    trace_context: dict[str, Any] | None = Field(None, max_length=200)
    evidence_summary: dict[str, Any] | None = Field(None, max_length=200)
    taxonomy: dict[str, Any] | None = Field(None, max_length=200)
    critic_scores: dict[str, Any] | None = Field(None, max_length=200)
    context_curation: dict[str, Any] | None = Field(None, max_length=200)
    streaming: TraceStreamingBody | None = None
    error: str | None = Field(None, max_length=20000)

    @model_validator(mode="after")
    def require_trace_or_request_id(self) -> Self:
        if not (self.trace_id or self.request_id):
            raise ValueError("trace_id or request_id is required")
        return self


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
    require_internal_service_token_request(request)


@router.post("/ingest")
async def ingest_trace(request: Request, body: TraceIngestBody = Body(...)):
    """Accept a trace record from planner-ts or yarn-ts via fire-and-forget POST."""
    _verify_service_token(request)
    record = body.model_dump(exclude_none=True)

    service = record.get("service", "unknown")
    trace_id = record.get("trace_id") or record.get("request_id", "")
    tokens = record.get("tokens", {})
    cost = record.get("cost", {})

    total_tokens = tokens.get("total_tokens", 0) or (
        tokens.get("prompt_tokens", 0) + tokens.get("completion_tokens", 0)
    )

    classification = record.get("classification") or {}
    difficulty = record.get("difficulty") or classification.get("difficulty", 0)
    task_type = record.get("task_type") or classification.get("taxonomy_key", "")
    is_code = record.get("is_code_task", False)
    if not is_code and isinstance(task_type, str):
        is_code = task_type.startswith("code") or "programming" in task_type
    has_error = bool(record.get("error") or record.get("has_error", False))
    iteration_count = record.get("iteration_count", 0) or 0

    trace_data = {
        "trace_id": trace_id,
        "user_id": record.get("user_id", ""),
        "org_id": record.get("org_id", ""),
        "tenant_id": record.get("tenant_id", ""),
        "conversation_id": record.get("conversation_id", ""),
        "parent_trace_id": record.get("parent_trace_id", ""),
        "root_trace_id": record.get("root_trace_id", ""),
        "query_snippet": record.get("query_snippet", ""),
        "timestamp": record.get("timestamp", time.time()),
        "total_duration_ms": record.get("latency_ms", 0),
        "total_tokens": total_tokens,
        "estimated_cost_usd": cost.get("estimated_usd", 0),
        "actual_cost_usd": cost.get("actual_usd", 0),
        "difficulty": difficulty,
        "task_type": task_type,
        "is_code_task": is_code,
        "has_error": has_error,
        "iteration_count": iteration_count,
        "full_record": record,
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


@router.post("/archive")
async def archive_traces(
    body: TraceArchiveRequest,
    user: UserInfo = Depends(require_platform_admin),
):
    """Archive selected or old trace rows to object storage, optionally deleting live rows."""
    if not body.trace_ids and body.older_than_days is None:
        raise HTTPException(status_code=400, detail="Provide trace_ids or older_than_days")
    try:
        return await trace_store.archive_traces(
            trace_ids=body.trace_ids,
            older_than_days=body.older_than_days,
            trace_service=body.trace_service,
            dry_run=body.dry_run,
            delete_after_archive=body.delete_after_archive,
            actor_user_id=user.user_id or user.username,
        )
    except ArchiveConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/purge")
async def purge_traces(
    older_than_days: int = Query(90, ge=1, le=3650),
    trace_service: str = Query("", max_length=32),
    dry_run: bool = Query(True),
    archive_before_delete: bool = Query(False),
    user: UserInfo = Depends(require_platform_admin),
):
    """Delete old trace rows, optionally archiving them to object storage first."""
    try:
        return await trace_store.purge_traces(
            older_than_days=older_than_days,
            trace_service=trace_service,
            dry_run=dry_run,
            archive_before_delete=archive_before_delete,
            actor_user_id=user.user_id or user.username,
        )
    except ArchiveConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
