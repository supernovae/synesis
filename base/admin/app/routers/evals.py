"""Evaluation harness API: run golden-prompt suites and retrieve results."""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import BenchmarkResult
from ..rbac import require_platform_admin
from ..services.eval_harness import BUILTIN_SUITES, EvalSuite, list_suites, run_eval_suite
from ..services.rag_eval_harness import list_rag_eval_suites, load_rag_eval_suite, run_rag_eval_suite

logger = logging.getLogger("synesis.admin.evals")

router = APIRouter(prefix="/api/v1/evals", tags=["evals"])

_YARN_URL = os.getenv(
    "SYNESIS_YARN_URL",
    "http://synesis-yarn.synesis-yarn.svc.cluster.local:8000",
)


class RunEvalRequest(BaseModel):
    suite_name: str = Field(..., description="Name of built-in suite to run")
    model: str = Field("synesis-agent", description="Target model name")


class RunRagEvalRequest(BaseModel):
    suite_name: str = Field(..., description="Name of SynPack eval suite to run")
    top_k: int = Field(8, ge=1, le=30)


@router.get("/suites")
async def get_eval_suites(
    _user: UserInfo = Depends(get_current_user),
):
    """List available eval suites and their case counts."""
    return {"suites": list_suites()}


@router.post("/run")
async def run_eval(
    body: RunEvalRequest,
    _user: UserInfo = Depends(require_platform_admin),
):
    """Execute an eval suite against Yarn. Platform-admin only."""
    suite = BUILTIN_SUITES.get(body.suite_name)
    if not suite:
        raise HTTPException(404, f"Suite '{body.suite_name}' not found. Available: {list(BUILTIN_SUITES.keys())}")

    effective_suite = EvalSuite(
        name=suite.name,
        cases=suite.cases,
        model=body.model or suite.model,
        description=suite.description,
    )

    try:
        result = await run_eval_suite(effective_suite, _YARN_URL)
        return result.to_dict()
    except Exception:
        logger.exception("eval_run_failed suite=%s", body.suite_name)
        raise HTTPException(500, "Eval run failed") from None


@router.get("/rag/suites")
async def get_rag_eval_suites(
    _user: UserInfo = Depends(get_current_user),
):
    """List YAML-backed SynPack retrieval eval suites."""
    try:
        return {"suites": list_rag_eval_suites()}
    except Exception:
        logger.exception("rag_eval_suite_list_failed")
        raise HTTPException(500, "Failed to list RAG eval suites") from None


def _benchmark_to_rag_eval(row: BenchmarkResult) -> dict:
    per_query = row.per_query or {}
    cases = per_query.get("cases", []) if isinstance(per_query, dict) else []
    training_rows = per_query.get("training_rows", []) if isinstance(per_query, dict) else []
    return {
        "run_id": row.run_id,
        "benchmark_type": row.benchmark_type,
        "suite_name": (per_query or {}).get("suite_name") if isinstance(per_query, dict) else "",
        "description": (per_query or {}).get("description") if isinstance(per_query, dict) else "",
        "aggregate": row.metrics or {},
        "per_query": cases,
        "training_rows": training_rows,
        "triggered_by": row.triggered_by,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "completed_at": row.completed_at.isoformat() if row.completed_at else None,
    }


@router.get("/rag/latest")
async def latest_rag_eval(
    _user: UserInfo = Depends(get_current_user),
):
    """Return the most recent SynPack retrieval eval run."""
    async with async_session() as session:
        row = (
            await session.execute(
                select(BenchmarkResult)
                .where(BenchmarkResult.benchmark_type == "synpack_retrieval_eval")
                .order_by(BenchmarkResult.started_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
    return _benchmark_to_rag_eval(row) if row else {"aggregate": {}, "per_query": [], "training_rows": []}


@router.get("/rag/history")
async def rag_eval_history(
    limit: int = 10,
    _user: UserInfo = Depends(get_current_user),
):
    """List recent SynPack retrieval eval runs."""
    limit = max(1, min(limit, 50))
    async with async_session() as session:
        rows = (
            (
                await session.execute(
                    select(BenchmarkResult)
                    .where(BenchmarkResult.benchmark_type == "synpack_retrieval_eval")
                    .order_by(BenchmarkResult.started_at.desc())
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
    return {"runs": [_benchmark_to_rag_eval(row) for row in rows]}


@router.post("/rag/run")
async def run_rag_eval(
    body: RunRagEvalRequest,
    _user: UserInfo = Depends(require_platform_admin),
):
    """Execute a SynPack retrieval eval suite against planner knowledge bundles."""
    try:
        suite = load_rag_eval_suite(body.suite_name)
    except KeyError:
        raise HTTPException(404, f"Suite '{body.suite_name}' not found")
    try:
        return await run_rag_eval_suite(
            suite,
            top_k=body.top_k,
            triggered_by=_user.email or _user.username or _user.user_id,
        )
    except Exception:
        logger.exception("rag_eval_run_failed suite=%s", body.suite_name)
        raise HTTPException(500, "RAG eval run failed") from None


@router.get("/rag/training-export")
async def rag_eval_training_export(
    run_id: str = "",
    _user: UserInfo = Depends(require_platform_admin),
):
    """Export retrieval eval training rows for SFT/reward-data pipelines."""
    async with async_session() as session:
        q = select(BenchmarkResult).where(BenchmarkResult.benchmark_type == "synpack_retrieval_eval")
        if run_id.strip():
            q = q.where(BenchmarkResult.run_id == run_id.strip()[:64])
        row = (await session.execute(q.order_by(BenchmarkResult.started_at.desc()).limit(1))).scalar_one_or_none()
    if not row:
        return {"run_id": run_id, "format": "jsonl", "rows": [], "jsonl": ""}
    data = _benchmark_to_rag_eval(row)
    rows = data.get("training_rows") or []
    import json

    return {
        "run_id": row.run_id,
        "format": "jsonl",
        "row_count": len(rows),
        "rows": rows,
        "jsonl": "\n".join(json.dumps(item, sort_keys=True) for item in rows) + ("\n" if rows else ""),
    }
