"""Closed-loop orchestration endpoints for dataset/eval/regression workflows."""

from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth import UserInfo, get_current_user, require_admin
from ..db.engine import async_session
from ..db.models import TestingLabsResult, TestingLabsRun
from ..services.eval_harness import BUILTIN_SUITES, list_suites, run_eval_suite
from ..services.testing_labs_engine import detect_regressions, execute_run

router = APIRouter(prefix="/api/v1/feedback-loop", tags=["feedback-loop"])

_YARN_URL = os.getenv(
    "SYNESIS_YARN_URL",
    "http://synesis-yarn.synesis-yarn.svc.cluster.local:8000",
)


class CreateLoopRunRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    description: str = Field("", max_length=4000)
    baseline_model: str = Field("", max_length=256)
    candidate_model: str = Field("synesis-agent", max_length=256)
    prompt_category: str = Field("", max_length=64)
    trace_filter: dict[str, Any] | None = None
    execute_now: bool = True
    eval_suites: list[str] = Field(default_factory=list)


class RunPipelineRequest(BaseModel):
    eval_suites: list[str] = Field(default_factory=list)
    auto_label: bool = True


def _label_result(row: TestingLabsResult) -> dict[str, Any]:
    detail = row.detail if isinstance(row.detail, dict) else {}
    tags: list[str] = []
    strengths: list[str] = []

    if row.candidate_verdict in {"fail", "error"}:
        tags.append("completion_failed")
    if row.candidate_tokens and row.candidate_tokens > max(1, row.baseline_tokens) * 2:
        tags.append("token_regression")
    if row.candidate_latency_ms and row.baseline_latency_ms and row.candidate_latency_ms > row.baseline_latency_ms * 2:
        tags.append("latency_regression")

    detail_text = json.dumps(detail).lower()
    if "invalid tool parameters" in detail_text:
        tags.append("invalid_tool_args")
    if "decision_path" in detail and detail.get("decision_path") == "abstain":
        tags.append("over_abstain")
    if row.candidate_verdict == "pass":
        strengths.append("completion_success")
    if row.candidate_tokens and row.candidate_tokens <= max(1, row.baseline_tokens):
        strengths.append("token_efficiency")
    if row.candidate_latency_ms and row.baseline_latency_ms and row.candidate_latency_ms <= row.baseline_latency_ms:
        strengths.append("latency_efficiency")

    return {"failure_tags": sorted(set(tags)), "strength_tags": sorted(set(strengths))}


@router.get("/overview")
async def feedback_loop_overview(_user: UserInfo = Depends(get_current_user)):
    async with async_session() as session:
        runs = (
            await session.execute(
                select(TestingLabsRun).order_by(TestingLabsRun.created_at.desc()).limit(20)
            )
        ).scalars().all()
    return {
        "suites": list_suites(),
        "recent_runs": [
            {
                "run_id": r.run_id,
                "name": r.name,
                "status": r.status,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "total_prompts": r.total_prompts,
                "completed_prompts": r.completed_prompts,
            }
            for r in runs
        ],
    }


@router.post("/runs")
async def create_feedback_loop_run(
    body: CreateLoopRunRequest,
    user: UserInfo = Depends(require_admin),
):
    run_id = f"fl-{uuid.uuid4().hex[:12]}"
    run = TestingLabsRun(
        run_id=run_id,
        name=body.name.strip(),
        description=body.description.strip(),
        status="pending",
        run_type="replay",
        created_by=user.username,
        org_id=getattr(user, "org_id", "") or "",
        baseline_model=body.baseline_model.strip(),
        candidate_model=body.candidate_model.strip(),
        prompt_category=body.prompt_category.strip(),
        trace_filter=body.trace_filter,
        config={
            "origin": "feedback-loop",
            "eval_suites": body.eval_suites,
            "created_at": datetime.now(UTC).isoformat(),
        },
    )
    async with async_session() as session:
        session.add(run)
        await session.commit()

    pipeline_result = {"run_id": run_id, "status": "pending"}
    if body.execute_now:
        pipeline_result = await _run_pipeline(run_id, body.eval_suites, auto_label=True)
    return pipeline_result


@router.post("/runs/{run_id}/pipeline")
async def run_feedback_pipeline(
    run_id: str,
    body: RunPipelineRequest,
    _user: UserInfo = Depends(require_admin),
):
    return await _run_pipeline(run_id, body.eval_suites, body.auto_label)


@router.post("/runs/{run_id}/auto-label")
async def auto_label_run(
    run_id: str,
    _user: UserInfo = Depends(require_admin),
):
    async with async_session() as session:
        rows = (
            await session.execute(
                select(TestingLabsResult)
                .where(TestingLabsResult.run_id == run_id)
                .order_by(TestingLabsResult.prompt_index)
            )
        ).scalars().all()
        if not rows:
            raise HTTPException(status_code=404, detail="No results found for run")
        for row in rows:
            labels = _label_result(row)
            detail = row.detail if isinstance(row.detail, dict) else {}
            detail["labels"] = labels
            row.detail = detail
        await session.commit()
    return {"run_id": run_id, "labeled_results": len(rows)}


@router.get("/runs/{run_id}/dataset")
async def export_training_dataset(
    run_id: str,
    format: str = Query("jsonl", pattern="^(jsonl|json)$"),
    _user: UserInfo = Depends(get_current_user),
):
    async with async_session() as session:
        run = (
            await session.execute(select(TestingLabsRun).where(TestingLabsRun.run_id == run_id))
        ).scalar_one_or_none()
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        rows = (
            await session.execute(
                select(TestingLabsResult)
                .where(TestingLabsResult.run_id == run_id)
                .order_by(TestingLabsResult.prompt_index)
            )
        ).scalars().all()
    if not rows:
        raise HTTPException(status_code=404, detail="No results found for run")

    records = []
    for row in rows:
        detail = row.detail if isinstance(row.detail, dict) else {}
        labels = detail.get("labels") if isinstance(detail.get("labels"), dict) else _label_result(row)
        records.append(
            {
                "task_id": f"{run_id}:{row.prompt_index}",
                "session_id": run_id,
                "model_id": run.candidate_model or "synesis-agent",
                "runtime_profile": "balanced_completion",
                "user_intent": row.prompt_category or "unknown",
                "trajectory_steps": [
                    {
                        "assistant_action": "candidate_response",
                        "tool_name": "n/a",
                        "args_valid": None,
                        "tool_result_class": row.candidate_verdict,
                        "token_cost": row.candidate_tokens,
                        "latency_ms": row.candidate_latency_ms,
                    }
                ],
                "outcome": "completed" if row.candidate_verdict == "pass" else "failed",
                "failure_tags": labels.get("failure_tags", []),
                "strength_tags": labels.get("strength_tags", []),
                "quality_signals": {
                    "candidate_verdict": row.candidate_verdict,
                    "tokens": row.candidate_tokens,
                    "latency_ms": row.candidate_latency_ms,
                    "baseline_tokens": row.baseline_tokens,
                    "baseline_latency_ms": row.baseline_latency_ms,
                },
                "gold_next_step": "",
                "prompt": row.prompt_text,
                "candidate_response": row.candidate_response,
            }
        )

    if format == "json":
        return {"run_id": run_id, "records": records}
    return {
        "run_id": run_id,
        "format": "jsonl",
        "records_jsonl": "\n".join(json.dumps(r, ensure_ascii=True) for r in records),
        "count": len(records),
    }


async def _run_pipeline(run_id: str, eval_suites: list[str], auto_label: bool) -> dict[str, Any]:
    run_out = await execute_run(run_id, _YARN_URL)
    if run_out.get("error"):
        raise HTTPException(status_code=409, detail=f"Run execution failed: {run_out.get('error')}")

    regression_report = await detect_regressions(run_id)
    eval_results: list[dict[str, Any]] = []
    for suite_name in eval_suites:
        suite = BUILTIN_SUITES.get(suite_name)
        if not suite:
            continue
        eval_result = await run_eval_suite(suite, _YARN_URL)
        eval_results.append(eval_result.to_dict())

    labeled_count = 0
    if auto_label:
        async with async_session() as session:
            rows = (
                await session.execute(select(TestingLabsResult).where(TestingLabsResult.run_id == run_id))
            ).scalars().all()
            for row in rows:
                detail = row.detail if isinstance(row.detail, dict) else {}
                detail["labels"] = _label_result(row)
                row.detail = detail
            await session.commit()
            labeled_count = len(rows)

    return {
        "run_id": run_id,
        "status": "completed",
        "replay": run_out,
        "regressions": regression_report.to_dict(),
        "eval_results": eval_results,
        "labeled_results": labeled_count,
    }
