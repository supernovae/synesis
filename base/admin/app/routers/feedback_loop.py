"""Closed-loop orchestration endpoints for dataset/eval/regression workflows."""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth import UserInfo, get_current_user, require_admin
from ..db.engine import async_session
from ..db.models import TestingLabsResult, TestingLabsRun, YarnSessionEvent
from ..services.eval_harness import BUILTIN_SUITES, list_suites, run_eval_suite
from ..services.testing_labs_engine import detect_regressions, execute_run

router = APIRouter(prefix="/api/v1/feedback-loop", tags=["feedback-loop"])
logger = logging.getLogger("synesis.admin.feedback_loop")

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
    wait_for_completion: bool = True
    eval_suites: list[str] = Field(default_factory=list)


class RunPipelineRequest(BaseModel):
    eval_suites: list[str] = Field(default_factory=list)
    auto_label: bool = True
    auto_critic_score: bool = True
    wait_for_completion: bool = True


class CriticScoreRequest(BaseModel):
    overwrite: bool = False


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


def _critic_scores_for_result(row: TestingLabsResult) -> dict[str, Any]:
    """Simple rubric score for RLAIF/DPO foundations."""
    detail = row.detail if isinstance(row.detail, dict) else {}
    labels = detail.get("labels") if isinstance(detail.get("labels"), dict) else _label_result(row)
    failure_tags = set(labels.get("failure_tags", []))
    strength_tags = set(labels.get("strength_tags", []))

    correctness = 1.0 if row.candidate_verdict == "pass" else 0.4 if row.candidate_verdict == "fail" else 0.2
    tool_validity = 0.7
    if "invalid_tool_args" in failure_tags:
        tool_validity = 0.3
    progress = 0.7 if row.candidate_verdict == "pass" else 0.4
    efficiency = 0.6
    if "token_efficiency" in strength_tags:
        efficiency += 0.2
    if "latency_efficiency" in strength_tags:
        efficiency += 0.2
    efficiency = min(1.0, efficiency)
    safety = 0.9
    if "over_abstain" in failure_tags or "completion_failed" in failure_tags:
        safety = 0.5

    reward = round(
        (0.35 * correctness) + (0.2 * tool_validity) + (0.2 * progress) + (0.15 * efficiency) + (0.1 * safety),
        4,
    )
    confidence = 0.8 if row.candidate_verdict in {"pass", "fail"} else 0.6
    return {
        "rubric": {
            "correctness": round(correctness, 4),
            "tool_validity": round(tool_validity, 4),
            "progress": round(progress, 4),
            "efficiency": round(efficiency, 4),
            "safety": round(safety, 4),
        },
        "reward_score": reward,
        "confidence": confidence,
    }


def _inject_labels_and_critic(row: TestingLabsResult) -> dict[str, Any]:
    detail = row.detail if isinstance(row.detail, dict) else {}
    labels = detail.get("labels") if isinstance(detail.get("labels"), dict) else _label_result(row)
    detail["labels"] = labels
    detail["critic"] = _critic_scores_for_result(row)
    return detail


def _trajectory_record(run: TestingLabsRun, run_id: str, row: TestingLabsResult) -> dict[str, Any]:
    detail = row.detail if isinstance(row.detail, dict) else {}
    labels = detail.get("labels") if isinstance(detail.get("labels"), dict) else _label_result(row)
    critic = detail.get("critic") if isinstance(detail.get("critic"), dict) else _critic_scores_for_result(row)
    return {
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
        "critic": critic,
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


def _rlaif_record(run: TestingLabsRun, run_id: str, row: TestingLabsResult) -> dict[str, Any]:
    traj = _trajectory_record(run, run_id, row)
    critic = traj.get("critic", {})
    return {
        "task_id": traj["task_id"],
        "prompt": traj["prompt"],
        "response": traj["candidate_response"],
        "reward_score": critic.get("reward_score", 0.0),
        "reward_confidence": critic.get("confidence", 0.5),
        "rubric": critic.get("rubric", {}),
        "labels": {
            "failure_tags": traj.get("failure_tags", []),
            "strength_tags": traj.get("strength_tags", []),
        },
        "meta": {
            "session_id": run_id,
            "model_id": run.candidate_model or "synesis-agent",
            "runtime_profile": traj.get("runtime_profile", "balanced_completion"),
            "prompt_category": row.prompt_category or "unknown",
        },
    }


def _dpo_pairs(run: TestingLabsRun, run_id: str, rows: list[TestingLabsResult]) -> list[dict[str, Any]]:
    pairs: list[dict[str, Any]] = []
    for row in rows:
        if not (row.candidate_response or "").strip():
            continue
        detail = row.detail if isinstance(row.detail, dict) else {}
        critic = detail.get("critic") if isinstance(detail.get("critic"), dict) else _critic_scores_for_result(row)
        cand_score = float(critic.get("reward_score", 0.0))
        baseline_response = (row.baseline_response or "").strip()
        baseline_score = 0.0
        if row.baseline_verdict == "pass":
            baseline_score += 0.7
        if row.baseline_tokens and row.candidate_tokens and row.baseline_tokens <= row.candidate_tokens:
            baseline_score += 0.1
        if row.baseline_latency_ms and row.candidate_latency_ms and row.baseline_latency_ms <= row.candidate_latency_ms:
            baseline_score += 0.1

        chosen = row.candidate_response
        rejected = baseline_response
        if baseline_response and baseline_score > cand_score:
            chosen = baseline_response
            rejected = row.candidate_response
        if not rejected:
            continue
        pairs.append(
            {
                "pair_id": f"{run_id}:{row.prompt_index}",
                "prompt": row.prompt_text,
                "chosen": chosen,
                "rejected": rejected,
                "scores": {"candidate": cand_score, "baseline": round(baseline_score, 4)},
                "meta": {
                    "session_id": run_id,
                    "model_id": run.candidate_model or "synesis-agent",
                    "prompt_category": row.prompt_category or "unknown",
                },
            }
        )
    return pairs


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
                "created_at": _to_iso_timestamp(r.created_at),
                "total_prompts": r.total_prompts,
                "completed_prompts": r.completed_prompts,
            }
            for r in runs
        ],
    }


@router.get("/runs/{run_id}")
async def feedback_loop_run_detail(
    run_id: str,
    _user: UserInfo = Depends(get_current_user),
):
    async with async_session() as session:
        run = (
            await session.execute(select(TestingLabsRun).where(TestingLabsRun.run_id == run_id))
        ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return {
        "run_id": run.run_id,
        "name": run.name,
        "status": run.status,
        "created_at": _to_iso_timestamp(run.created_at),
        "started_at": _to_iso_timestamp(run.started_at),
        "completed_at": _to_iso_timestamp(run.completed_at),
        "total_prompts": run.total_prompts,
        "completed_prompts": run.completed_prompts,
        "failed_prompts": run.failed_prompts,
        "comparison": run.comparison if isinstance(run.comparison, dict) else {},
    }


@router.post("/runs")
async def create_feedback_loop_run(
    body: CreateLoopRunRequest,
    background_tasks: BackgroundTasks,
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

    pipeline_result: dict[str, Any] = {"run_id": run_id, "status": "pending"}
    if body.execute_now:
        if body.wait_for_completion:
            pipeline_result = await _run_pipeline(run_id, body.eval_suites, auto_label=True)
        else:
            # Queue execution to avoid request timeouts in UI/proxies for longer replay/eval runs.
            background_tasks.add_task(
                _run_pipeline_background,
                run_id,
                body.eval_suites,
                True,
                True,
            )
            pipeline_result = {"run_id": run_id, "status": "running", "queued": True}
    return _public_pipeline_response(pipeline_result)


@router.post("/runs/{run_id}/pipeline")
async def run_feedback_pipeline(
    run_id: str,
    body: RunPipelineRequest,
    background_tasks: BackgroundTasks,
    _user: UserInfo = Depends(require_admin),
):
    if not body.wait_for_completion:
        background_tasks.add_task(
            _run_pipeline_background,
            run_id,
            body.eval_suites,
            body.auto_label,
            body.auto_critic_score,
        )
        return {"run_id": run_id, "status": "running", "queued": True}
    pipeline_result = await _run_pipeline(run_id, body.eval_suites, body.auto_label, body.auto_critic_score)
    return _public_pipeline_response(pipeline_result)


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


@router.post("/runs/{run_id}/critic-score")
async def critic_score_run(
    run_id: str,
    body: CriticScoreRequest,
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
        scored = 0
        for row in rows:
            detail = row.detail if isinstance(row.detail, dict) else {}
            if not body.overwrite and isinstance(detail.get("critic"), dict):
                continue
            row.detail = _inject_labels_and_critic(row)
            scored += 1
        await session.commit()
    return {"run_id": run_id, "scored_results": scored, "total_results": len(rows)}


@router.get("/runs/{run_id}/preferences")
async def export_dpo_preferences(
    run_id: str,
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
    pairs = _dpo_pairs(run, run_id, rows)
    return {"run_id": run_id, "count": len(pairs), "pairs": pairs}


@router.get("/runs/{run_id}/dataset")
async def export_training_dataset(
    run_id: str,
    format: str = Query("jsonl", pattern="^(jsonl|json)$"),
    dataset_type: str = Query("trajectory", pattern="^(trajectory|dpo|rlaif|eval_gym)$"),
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

    records: list[dict[str, Any]]
    if dataset_type == "eval_gym":
        records = await _eval_gym_records(run_id)
    elif dataset_type == "trajectory":
        records = [_trajectory_record(run, run_id, row) for row in rows]
    elif dataset_type == "rlaif":
        records = [_rlaif_record(run, run_id, row) for row in rows if (row.candidate_response or "").strip()]
    else:
        records = _dpo_pairs(run, run_id, rows)

    if format == "json":
        return {"run_id": run_id, "dataset_type": dataset_type, "records": records}
    return {
        "run_id": run_id,
        "dataset_type": dataset_type,
        "format": "jsonl",
        "records_jsonl": "\n".join(json.dumps(r, ensure_ascii=True) for r in records),
        "count": len(records),
    }


async def _eval_gym_records(run_id: str) -> list[dict[str, Any]]:
    """Pull eval gym events (scenario_eval_v1, eval_transcript_v1) from yarn_session_events."""
    async with async_session() as session:
        events = (
            await session.execute(
                select(YarnSessionEvent)
                .where(YarnSessionEvent.event_kind.in_(["scenario_eval_v1", "eval_transcript_v1"]))
                .order_by(YarnSessionEvent.created_at.desc())
                .limit(500)
            )
        ).scalars().all()

    records: list[dict[str, Any]] = []
    for ev in events:
        meta = ev.metadata_json if isinstance(ev.metadata_json, dict) else {}
        records.append({
            "task_id": f"eval:{meta.get('scenario_id', 'unknown')}:{ev.id}",
            "session_id": ev.session_key,
            "event_kind": ev.event_kind,
            "model_id": meta.get("model", "unknown"),
            "runtime_profile": "balanced_completion",
            "user_intent": meta.get("category", "eval"),
            "outcome": "completed" if meta.get("passed") else "stalled",
            "quality_signals": {
                "score": meta.get("score"),
                "total_turns": meta.get("total_turns"),
                "total_anomalies": meta.get("anomaly_count", meta.get("total_anomalies")),
                "governor_interventions": meta.get("governor_interventions"),
            },
            "governor": {
                "rules_fired": meta.get("governor_rules", meta.get("all_governor_rules", [])),
            },
            "training_signals": {
                "governor_intervened": bool(meta.get("governor_interventions")),
                "anomaly_count": meta.get("anomaly_count", meta.get("total_anomalies", 0)),
            },
            "metadata": meta,
            "created_at": _to_iso_timestamp(ev.created_at),
        })
    return records


@router.get("/eval-gym/events")
async def list_eval_gym_events(
    event_kind: str = Query("scenario_eval_v1", pattern="^(scenario_eval_v1|live_eval_v1|eval_transcript_v1)$"),
    limit: int = Query(50, ge=1, le=500),
    _user: UserInfo = Depends(get_current_user),
):
    """Query eval gym events from yarn_session_events."""
    async with async_session() as session:
        events = (
            await session.execute(
                select(YarnSessionEvent)
                .where(YarnSessionEvent.event_kind == event_kind)
                .order_by(YarnSessionEvent.created_at.desc())
                .limit(limit)
            )
        ).scalars().all()

    return {
        "event_kind": event_kind,
        "count": len(events),
        "events": [
            {
                "id": ev.id,
                "session_key": ev.session_key,
                "request_id": ev.request_id,
                "detail": ev.detail,
                "metadata_json": ev.metadata_json,
                "created_at": _to_iso_timestamp(ev.created_at),
            }
            for ev in events
        ],
    }


async def _run_pipeline(run_id: str, eval_suites: list[str], auto_label: bool, auto_critic_score: bool = True) -> dict[str, Any]:
    run_out = await execute_run(run_id, _YARN_URL)
    if run_out.get("error"):
        logger.warning(
            "feedback_loop_pipeline_run_failed run_id=%s error=%s",
            run_id,
            run_out.get("error"),
        )
        raise HTTPException(status_code=409, detail="Run execution failed. See server logs for details.")

    regression_report = await detect_regressions(run_id)
    eval_results: list[dict[str, Any]] = []
    for suite_name in eval_suites:
        suite = BUILTIN_SUITES.get(suite_name)
        if not suite:
            continue
        eval_result = await run_eval_suite(suite, _YARN_URL)
        eval_results.append(eval_result.to_dict())

    labeled_count = 0
    scored_count = 0
    if auto_label:
        async with async_session() as session:
            rows = (
                await session.execute(select(TestingLabsResult).where(TestingLabsResult.run_id == run_id))
            ).scalars().all()
            for row in rows:
                if auto_critic_score:
                    row.detail = _inject_labels_and_critic(row)
                    scored_count += 1
                else:
                    detail = row.detail if isinstance(row.detail, dict) else {}
                    detail["labels"] = _label_result(row)
                    row.detail = detail
            await session.commit()
            labeled_count = len(rows)

    return {
        "run_id": run_id,
        "status": "completed",
        "replay": {
            "status": run_out.get("status", "completed"),
            "run_id": run_out.get("run_id", run_id),
        },
        "regressions": regression_report.to_dict(),
        "eval_results": eval_results,
        "labeled_results": labeled_count,
        "critic_scored_results": scored_count,
    }


def _public_pipeline_response(result: dict[str, Any]) -> dict[str, Any]:
    response: dict[str, Any] = {
        "run_id": str(result.get("run_id") or ""),
        "status": str(result.get("status") or "unknown"),
    }
    if "queued" in result:
        response["queued"] = bool(result.get("queued"))

    replay = result.get("replay")
    if isinstance(replay, dict):
        response["replay"] = {
            "status": str(replay.get("status") or "completed"),
            "run_id": str(replay.get("run_id") or response["run_id"]),
        }

    regressions = result.get("regressions")
    if isinstance(regressions, dict):
        response["regressions"] = regressions

    eval_results = result.get("eval_results")
    if isinstance(eval_results, list):
        response["eval_results"] = [_public_eval_result(item) for item in eval_results if isinstance(item, dict)]

    for key in ("labeled_results", "critic_scored_results"):
        if key in result:
            response[key] = int(result.get(key) or 0)
    return response


def _public_eval_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "suite_name": str(result.get("suite_name") or ""),
        "total_cases": int(result.get("total_cases") or 0),
        "passed": int(result.get("passed") or 0),
        "failed": int(result.get("failed") or 0),
        "errored": int(result.get("errored") or 0),
        "pass_rate": float(result.get("pass_rate") or 0),
        "elapsed_ms": float(result.get("elapsed_ms") or 0),
        "cases": [
            _public_eval_case(case)
            for case in result.get("cases", [])
            if isinstance(case, dict)
        ],
    }


def _public_eval_case(case: dict[str, Any]) -> dict[str, Any]:
    return {
        "case_index": int(case.get("case_index") or 0),
        "prompt_snippet": str(case.get("prompt_snippet") or ""),
        "category": str(case.get("category") or ""),
        "passed": bool(case.get("passed")),
        "latency_ms": float(case.get("latency_ms") or 0),
        "tokens": int(case.get("tokens") or 0),
        "actual_decision_path": case.get("actual_decision_path"),
        "actual_recall_routing": case.get("actual_recall_routing"),
        "actual_languages": case.get("actual_languages") if isinstance(case.get("actual_languages"), list) else None,
        "decision_path_match": case.get("decision_path_match"),
        "recall_routing_match": case.get("recall_routing_match"),
        "language_match": case.get("language_match"),
        "failures": case.get("failures") if isinstance(case.get("failures"), list) else [],
        "warnings": case.get("warnings") if isinstance(case.get("warnings"), list) else [],
    }


def _to_iso_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str):
        return value
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()  # type: ignore[no-any-return]
        except Exception:
            return str(value)
    return str(value)


async def _run_pipeline_background(
    run_id: str,
    eval_suites: list[str],
    auto_label: bool,
    auto_critic_score: bool,
) -> None:
    try:
        await _run_pipeline(run_id, eval_suites, auto_label, auto_critic_score)
    except Exception:
        # Keep background failures from tearing down request handlers.
        # The underlying run row is still updated by execute_run/_finalize_run on failure paths.
        logger.exception(
            "feedback_loop_background_pipeline_failed run_id=%s",
            run_id,
        )
