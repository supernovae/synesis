"""Testing Labs: replay runs, quality comparison, HITL review, and execution engine."""

from __future__ import annotations

import logging
import os
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..auth import UserInfo, get_current_user, require_admin
from ..db.engine import async_session
from ..db.models import TestingLabsResult, TestingLabsRun
from ..services import testing_labs_engine

logger = logging.getLogger("synesis.admin.testing_labs")

router = APIRouter(prefix="/api/v1/testing-labs", tags=["testing-labs"])


# ── Request / response models ────────────────────────────────────────────────


class CreateRunRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    description: str = Field("", max_length=4000)
    run_type: Literal["replay", "prompt_suite", "custom"] = "replay"
    baseline_model: str = Field("", max_length=256)
    candidate_model: str = Field("", max_length=256)
    prompt_category: str = Field("", max_length=64)
    trace_filter: dict[str, Any] | None = None
    config: dict[str, Any] | None = None


class ReviewResultRequest(BaseModel):
    review_status: Literal["pending", "approved", "rejected", "needs_review"] = "approved"
    reviewer_note: str = Field("", max_length=8000)


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.get("/runs")
async def list_runs(
    status: str = Query("", description="Filter by status: pending, running, completed, failed"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _user: UserInfo = Depends(get_current_user),
):
    async with async_session() as session:
        base = select(TestingLabsRun)
        if status:
            base = base.where(TestingLabsRun.status == status)

        total = (await session.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
        stmt = base.order_by(TestingLabsRun.created_at.desc()).offset(offset).limit(limit)
        rows = (await session.execute(stmt)).scalars().all()

    return {
        "runs": [_run_to_dict(r) for r in rows],
        "total": total,
    }


@router.post("/runs")
async def create_run(
    body: CreateRunRequest,
    user: UserInfo = Depends(require_admin),
):
    run_id = f"tl-{uuid.uuid4().hex[:12]}"
    run = TestingLabsRun(
        run_id=run_id,
        name=body.name.strip(),
        description=body.description.strip(),
        status="pending",
        run_type=body.run_type,
        created_by=user.username,
        org_id=getattr(user, "org_id", "") or "",
        baseline_model=body.baseline_model.strip(),
        candidate_model=body.candidate_model.strip(),
        prompt_category=body.prompt_category.strip(),
        trace_filter=body.trace_filter,
        config=body.config,
    )

    async with async_session() as session:
        session.add(run)
        await session.commit()

    logger.info("testing_labs_run_created run_id=%s name=%s by=%s", run_id, body.name, user.username)
    return {"run_id": run_id, "status": "pending"}


@router.get("/runs/{run_id}")
async def get_run(
    run_id: str,
    _user: UserInfo = Depends(get_current_user),
):
    async with async_session() as session:
        stmt = select(TestingLabsRun).where(TestingLabsRun.run_id == run_id)
        row = (await session.execute(stmt)).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")
    return _run_to_dict(row)


@router.post("/runs/{run_id}/start")
async def start_run(
    run_id: str,
    _user: UserInfo = Depends(require_admin),
):
    async with async_session() as session:
        stmt = select(TestingLabsRun).where(TestingLabsRun.run_id == run_id)
        row = (await session.execute(stmt)).scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Run not found")
        if row.status not in ("pending", "failed"):
            raise HTTPException(status_code=409, detail=f"Run is {row.status}, cannot start")
        row.status = "running"
        row.started_at = datetime.now(UTC)
        await session.commit()

    logger.info("testing_labs_run_started run_id=%s", run_id)
    return {"run_id": run_id, "status": "running"}


@router.post("/runs/{run_id}/cancel")
async def cancel_run(
    run_id: str,
    _user: UserInfo = Depends(require_admin),
):
    async with async_session() as session:
        stmt = select(TestingLabsRun).where(TestingLabsRun.run_id == run_id)
        row = (await session.execute(stmt)).scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Run not found")
        if row.status in ("completed", "cancelled"):
            raise HTTPException(status_code=409, detail=f"Run is {row.status}")
        row.status = "cancelled"
        row.completed_at = datetime.now(UTC)
        await session.commit()

    return {"run_id": run_id, "status": "cancelled"}


@router.delete("/runs/{run_id}")
async def delete_run(
    run_id: str,
    _user: UserInfo = Depends(require_admin),
):
    async with async_session() as session:
        stmt = select(TestingLabsRun).where(TestingLabsRun.run_id == run_id)
        row = (await session.execute(stmt)).scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Run not found")
        if row.status == "running":
            raise HTTPException(status_code=409, detail="Cannot delete a running run")

        from sqlalchemy import delete as sa_delete

        await session.execute(sa_delete(TestingLabsResult).where(TestingLabsResult.run_id == run_id))
        await session.delete(row)
        await session.commit()

    return {"deleted": run_id}


# ── Results ───────────────────────────────────────────────────────────────────


@router.get("/runs/{run_id}/results")
async def list_results(
    run_id: str,
    review_status: str = Query("", description="Filter: pending, approved, rejected, needs_review"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _user: UserInfo = Depends(get_current_user),
):
    async with async_session() as session:
        base = select(TestingLabsResult).where(TestingLabsResult.run_id == run_id)
        if review_status:
            base = base.where(TestingLabsResult.review_status == review_status)

        total = (await session.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
        stmt = base.order_by(TestingLabsResult.prompt_index).offset(offset).limit(limit)
        rows = (await session.execute(stmt)).scalars().all()

    return {
        "results": [_result_to_dict(r) for r in rows],
        "total": total,
    }


@router.patch("/results/{result_id}/review")
async def review_result(
    result_id: int,
    body: ReviewResultRequest,
    user: UserInfo = Depends(require_admin),
):
    async with async_session() as session:
        row = await session.get(TestingLabsResult, result_id)
        if not row:
            raise HTTPException(status_code=404, detail="Result not found")
        row.review_status = body.review_status
        row.reviewer = user.username
        row.reviewer_note = body.reviewer_note.strip()
        await session.commit()

    return {"id": result_id, "review_status": body.review_status}


# ── Execution engine ──────────────────────────────────────────────────────────

_YARN_URL = os.getenv(
    "SYNESIS_YARN_URL",
    "http://synesis-yarn.synesis-yarn.svc.cluster.local:8000",
)


@router.post("/runs/{run_id}/execute")
async def execute_run(
    run_id: str,
    _user: UserInfo = Depends(require_admin),
):
    """Execute a Testing Labs run: replay prompts from traces against Yarn."""
    result = await testing_labs_engine.execute_run(run_id, _YARN_URL)
    if result.get("error"):
        status_code = 404 if "not found" in result["error"].lower() else 409
        raise HTTPException(status_code=status_code, detail=result["error"])
    return result


@router.get("/runs/{run_id}/regressions")
async def get_regressions(
    run_id: str,
    _user: UserInfo = Depends(get_current_user),
):
    """Regression report for a completed Testing Labs run."""
    report = await testing_labs_engine.detect_regressions(run_id)
    return report.to_dict()


# ── Comparison / metrics ──────────────────────────────────────────────────────


@router.get("/runs/{run_id}/comparison")
async def get_comparison(
    run_id: str,
    _user: UserInfo = Depends(get_current_user),
):
    async with async_session() as session:
        run_stmt = select(TestingLabsRun).where(TestingLabsRun.run_id == run_id)
        run = (await session.execute(run_stmt)).scalar_one_or_none()
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")

        results_stmt = select(TestingLabsResult).where(TestingLabsResult.run_id == run_id)
        results = (await session.execute(results_stmt)).scalars().all()

    if not results:
        return {
            "run_id": run_id,
            "status": run.status,
            "baseline": {},
            "candidate": {},
            "diff": {},
        }

    n = len(results)
    baseline = _aggregate_side(results, "baseline")
    candidate = _aggregate_side(results, "candidate")
    diff = {
        k: round(candidate.get(k, 0) - baseline.get(k, 0), 4) for k in baseline if isinstance(baseline[k], (int, float))
    }

    return {
        "run_id": run_id,
        "status": run.status,
        "total_prompts": n,
        "baseline": baseline,
        "candidate": candidate,
        "diff": diff,
    }


# ── Stats ─────────────────────────────────────────────────────────────────────


@router.get("/stats")
async def testing_labs_stats(_user: UserInfo = Depends(get_current_user)):
    async with async_session() as session:
        total = (await session.execute(select(func.count()).select_from(TestingLabsRun))).scalar() or 0
        pending = (
            await session.execute(
                select(func.count()).select_from(
                    select(TestingLabsRun).where(TestingLabsRun.status == "pending").subquery()
                )
            )
        ).scalar() or 0
        running = (
            await session.execute(
                select(func.count()).select_from(
                    select(TestingLabsRun).where(TestingLabsRun.status == "running").subquery()
                )
            )
        ).scalar() or 0
        completed = (
            await session.execute(
                select(func.count()).select_from(
                    select(TestingLabsRun).where(TestingLabsRun.status == "completed").subquery()
                )
            )
        ).scalar() or 0
        needs_review = (
            await session.execute(
                select(func.count()).select_from(
                    select(TestingLabsResult).where(TestingLabsResult.review_status == "needs_review").subquery()
                )
            )
        ).scalar() or 0

    return {
        "total_runs": total,
        "pending": pending,
        "running": running,
        "completed": completed,
        "needs_review": needs_review,
    }


# ── Helpers ───────────────────────────────────────────────────────────────────


def _run_to_dict(r: TestingLabsRun) -> dict[str, Any]:
    return {
        "run_id": r.run_id,
        "name": r.name,
        "description": r.description,
        "status": r.status,
        "run_type": r.run_type,
        "created_by": r.created_by,
        "org_id": r.org_id,
        "baseline_model": r.baseline_model,
        "candidate_model": r.candidate_model,
        "prompt_category": r.prompt_category,
        "trace_filter": r.trace_filter,
        "config": r.config,
        "total_prompts": r.total_prompts,
        "completed_prompts": r.completed_prompts,
        "failed_prompts": r.failed_prompts,
        "baseline_metrics": r.baseline_metrics,
        "candidate_metrics": r.candidate_metrics,
        "comparison": r.comparison,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
    }


def _result_to_dict(r: TestingLabsResult) -> dict[str, Any]:
    return {
        "id": r.id,
        "run_id": r.run_id,
        "prompt_index": r.prompt_index,
        "prompt_text": r.prompt_text[:500],
        "prompt_category": r.prompt_category,
        "source_trace_id": r.source_trace_id,
        "baseline_latency_ms": r.baseline_latency_ms,
        "baseline_tokens": r.baseline_tokens,
        "baseline_citation_count": r.baseline_citation_count,
        "baseline_verdict": r.baseline_verdict,
        "candidate_latency_ms": r.candidate_latency_ms,
        "candidate_tokens": r.candidate_tokens,
        "candidate_citation_count": r.candidate_citation_count,
        "candidate_verdict": r.candidate_verdict,
        "review_status": r.review_status,
        "reviewer": r.reviewer,
        "reviewer_note": r.reviewer_note,
        "detail": r.detail,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


def _aggregate_side(results: list[TestingLabsResult], side: str) -> dict[str, Any]:
    n = len(results)
    if n == 0:
        return {}
    lat_key = f"{side}_latency_ms"
    tok_key = f"{side}_tokens"
    cit_key = f"{side}_citation_count"
    ver_key = f"{side}_verdict"

    lats = [getattr(r, lat_key, 0) for r in results]
    toks = [getattr(r, tok_key, 0) for r in results]
    cits = [getattr(r, cit_key, 0) for r in results]
    verdicts = [getattr(r, ver_key, "") for r in results]
    pass_count = sum(1 for v in verdicts if v == "pass")
    fail_count = sum(1 for v in verdicts if v == "fail")

    return {
        "avg_latency_ms": round(sum(lats) / n, 1),
        "avg_tokens": round(sum(toks) / n),
        "avg_citations": round(sum(cits) / n, 2),
        "pass_rate": round(pass_count / n, 4) if n else 0,
        "fail_count": fail_count,
        "total": n,
    }
