"""Testing Labs execution engine: replay prompts, populate results, detect regressions."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import select

from ..db.engine import async_session
from ..db.models import TestingLabsResult, TestingLabsRun, Trace
from ..deps import INTERNAL_SERVICE_TOKEN
from .testing_labs_contract import parse_stored_trace_filter

logger = logging.getLogger("synesis.admin.testing_labs_engine")


@dataclass
class Regression:
    prompt_index: int
    prompt_snippet: str
    kind: str
    baseline_value: Any = None
    candidate_value: Any = None
    detail: str = ""


@dataclass
class RegressionReport:
    run_id: str
    total_results: int
    regressions: list[Regression] = field(default_factory=list)
    regression_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "total_results": self.total_results,
            "regression_count": self.regression_count,
            "regressions": [
                {
                    "prompt_index": r.prompt_index,
                    "prompt_snippet": r.prompt_snippet,
                    "kind": r.kind,
                    "baseline_value": r.baseline_value,
                    "candidate_value": r.candidate_value,
                    "detail": r.detail,
                }
                for r in self.regressions
            ],
        }


async def execute_run(run_id: str, yarn_url: str) -> dict[str, Any]:
    """Execute a Testing Labs run: extract prompts from traces, replay against Yarn."""
    async with async_session() as session:
        run = (
            await session.execute(select(TestingLabsRun).where(TestingLabsRun.run_id == run_id))
        ).scalar_one_or_none()
        if not run:
            return {"error": "Run not found", "run_id": run_id}
        if run.status not in ("pending", "failed"):
            return {"error": f"Run is {run.status}, cannot execute", "run_id": run_id}

        run.status = "running"
        run.started_at = datetime.now(UTC)
        await session.commit()

    try:
        prompts = await _extract_prompts(run_id)
        if not prompts:
            await _finalize_run(run_id, "failed", error_detail="No prompts extracted from traces")
            return {"error": "No prompts extracted", "run_id": run_id}

        results_written = 0
        for i, prompt_info in enumerate(prompts):
            result = await _replay_prompt(
                i,
                prompt_info,
                yarn_url,
            )
            await _write_result(run_id, result)
            results_written += 1

        await _finalize_run(run_id, "completed", total=results_written)
        return {"status": "completed", "run_id": run_id, "results": results_written}

    except Exception as exc:
        logger.error("testing_labs_execute_failed run_id=%s error=%s", run_id, exc)
        await _finalize_run(run_id, "failed", error_detail=str(exc)[:500])
        return {"error": str(exc)[:500], "run_id": run_id}


async def _extract_prompts(run_id: str) -> list[dict[str, Any]]:
    """Pull prompt texts from matching historical traces."""
    async with async_session() as session:
        run = (
            await session.execute(select(TestingLabsRun).where(TestingLabsRun.run_id == run_id))
        ).scalar_one_or_none()
        if not run:
            return []

        q = select(Trace).order_by(Trace.timestamp.desc()).limit(50)

        try:
            tf = parse_stored_trace_filter(run.trace_filter)
        except ValueError as exc:
            logger.warning("testing_labs_invalid_trace_filter run_id=%s error=%s", run_id, exc)
            return []
        if tf.since:
            q = q.where(Trace.timestamp >= tf.since)
        if tf.until:
            q = q.where(Trace.timestamp <= tf.until)
        if tf.task_type:
            q = q.where(Trace.task_type == tf.task_type)
        if tf.org_id:
            q = q.where(Trace.full_record["org_id"].astext == tf.org_id)
        if run.prompt_category:
            q = q.where(Trace.task_type == run.prompt_category)

        rows = (await session.execute(q)).scalars().all()

    prompts: list[dict[str, Any]] = []
    for row in rows:
        snippet = row.query_snippet or ""
        full = row.full_record or {}
        prompt_text = full.get("query_snippet") or snippet
        if not prompt_text or len(prompt_text) < 5:
            continue
        prompts.append(
            {
                "prompt_text": prompt_text,
                "source_trace_id": row.trace_id,
                "category": row.task_type or "",
            }
        )

    return prompts


async def _replay_prompt(
    index: int,
    prompt_info: dict[str, Any],
    yarn_url: str,
) -> dict[str, Any]:
    """Send prompt to Yarn, collect response metadata."""
    prompt_text = prompt_info["prompt_text"]
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if INTERNAL_SERVICE_TOKEN:
        headers["Authorization"] = f"Bearer {INTERNAL_SERVICE_TOKEN}"

    result: dict[str, Any] = {
        "prompt_index": index,
        "prompt_text": prompt_text,
        "prompt_category": prompt_info.get("category", ""),
        "source_trace_id": prompt_info.get("source_trace_id", ""),
    }

    t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{yarn_url.rstrip('/')}/v1/chat/completions",
                json={
                    "model": "synesis-agent",
                    "messages": [{"role": "user", "content": prompt_text}],
                    "max_tokens": 512,
                    "stream": False,
                },
                headers=headers,
            )
            latency = (time.time() - t0) * 1000
            data = resp.json() if resp.status_code < 400 else {}

            usage = data.get("usage", {})
            tokens = usage.get("total_tokens", 0)
            response_text = ""
            choices = data.get("choices", [])
            if choices:
                response_text = choices[0].get("message", {}).get("content", "")[:4000]

            verdict = "pass" if resp.status_code < 400 else "fail"
            result.update(
                {
                    "candidate_response": response_text,
                    "candidate_latency_ms": round(latency, 1),
                    "candidate_tokens": tokens,
                    "candidate_verdict": verdict,
                    "candidate_detail": {
                        "status_code": resp.status_code,
                        "decision_path": data.get("_decision_path"),
                        "recall_routing": data.get("_recall_routing"),
                    },
                }
            )

    except Exception as exc:
        latency = (time.time() - t0) * 1000
        result.update(
            {
                "candidate_response": "",
                "candidate_latency_ms": round(latency, 1),
                "candidate_tokens": 0,
                "candidate_verdict": "error",
                "candidate_detail": {"error": str(exc)[:200]},
            }
        )

    return result


async def _write_result(run_id: str, result: dict[str, Any]) -> None:
    async with async_session() as session:
        row = TestingLabsResult(
            run_id=run_id,
            prompt_index=result["prompt_index"],
            prompt_text=result["prompt_text"][:4000],
            prompt_category=result.get("prompt_category", ""),
            source_trace_id=result.get("source_trace_id", ""),
            candidate_response=result.get("candidate_response", ""),
            candidate_latency_ms=result.get("candidate_latency_ms", 0),
            candidate_tokens=result.get("candidate_tokens", 0),
            candidate_verdict=result.get("candidate_verdict", ""),
            detail=result.get("candidate_detail"),
            review_status="pending",
        )
        session.add(row)
        await session.commit()


async def _finalize_run(
    run_id: str,
    status: str,
    total: int = 0,
    error_detail: str = "",
) -> None:
    async with async_session() as session:
        run = (
            await session.execute(select(TestingLabsRun).where(TestingLabsRun.run_id == run_id))
        ).scalar_one_or_none()
        if not run:
            return
        run.status = status
        run.completed_at = datetime.now(UTC)
        if total > 0:
            run.total_prompts = total
            run.completed_prompts = total
        if error_detail:
            run.comparison = {"error": error_detail}
        await session.commit()


async def detect_regressions(run_id: str) -> RegressionReport:
    """Analyze results for regressions based on rule-based thresholds."""
    async with async_session() as session:
        results = (
            (
                await session.execute(
                    select(TestingLabsResult)
                    .where(TestingLabsResult.run_id == run_id)
                    .order_by(TestingLabsResult.prompt_index)
                )
            )
            .scalars()
            .all()
        )

    if not results:
        return RegressionReport(run_id=run_id, total_results=0)

    regressions: list[Regression] = []

    for r in results:
        snippet = (r.prompt_text or "")[:80]
        detail = r.detail or {}

        if r.candidate_verdict == "error":
            regressions.append(
                Regression(
                    prompt_index=r.prompt_index,
                    prompt_snippet=snippet,
                    kind="error",
                    candidate_value=r.candidate_verdict,
                    detail="Candidate returned an error",
                )
            )

        if r.candidate_verdict == "fail" and r.baseline_verdict == "pass":
            regressions.append(
                Regression(
                    prompt_index=r.prompt_index,
                    prompt_snippet=snippet,
                    kind="verdict_degradation",
                    baseline_value="pass",
                    candidate_value="fail",
                    detail="Baseline passed but candidate failed",
                )
            )

        if (
            r.baseline_latency_ms > 0
            and r.candidate_latency_ms > 0
            and r.candidate_latency_ms > r.baseline_latency_ms * 2
        ):
            regressions.append(
                Regression(
                    prompt_index=r.prompt_index,
                    prompt_snippet=snippet,
                    kind="latency_regression",
                    baseline_value=round(r.baseline_latency_ms, 1),
                    candidate_value=round(r.candidate_latency_ms, 1),
                    detail="Candidate latency >2x baseline",
                )
            )

        if r.baseline_tokens > 0 and r.candidate_tokens > 0 and r.candidate_tokens > r.baseline_tokens * 2:
            regressions.append(
                Regression(
                    prompt_index=r.prompt_index,
                    prompt_snippet=snippet,
                    kind="token_regression",
                    baseline_value=r.baseline_tokens,
                    candidate_value=r.candidate_tokens,
                    detail="Candidate tokens >2x baseline",
                )
            )

        baseline_dp = (r.detail or {}).get("baseline_decision_path")
        candidate_dp = detail.get("decision_path")
        if baseline_dp and candidate_dp and baseline_dp != candidate_dp:
            dp_rank = {"deterministic": 0, "constrained": 1, "inference_first": 2, "abstain": 3}
            if dp_rank.get(candidate_dp, 99) > dp_rank.get(baseline_dp, 99):
                regressions.append(
                    Regression(
                        prompt_index=r.prompt_index,
                        prompt_snippet=snippet,
                        kind="decision_path_degradation",
                        baseline_value=baseline_dp,
                        candidate_value=candidate_dp,
                        detail=f"Decision path degraded: {baseline_dp} -> {candidate_dp}",
                    )
                )

    report = RegressionReport(
        run_id=run_id,
        total_results=len(results),
        regressions=regressions,
        regression_count=len(regressions),
    )
    return report
