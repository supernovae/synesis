"""Evaluation harness API: run golden-prompt suites and retrieve results."""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import UserInfo, get_current_user
from ..rbac import require_platform_admin
from ..services.eval_harness import BUILTIN_SUITES, EvalSuite, list_suites, run_eval_suite

logger = logging.getLogger("synesis.admin.evals")

router = APIRouter(prefix="/api/v1/evals", tags=["evals"])

_YARN_URL = os.getenv(
    "SYNESIS_YARN_URL",
    "http://synesis-yarn.synesis-yarn.svc.cluster.local:8000",
)


class RunEvalRequest(BaseModel):
    suite_name: str = Field(..., description="Name of built-in suite to run")
    model: str = Field("synesis-agent", description="Target model name")


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
    except Exception as exc:
        logger.error("eval_run_failed suite=%s error=%s", body.suite_name, exc)
        raise HTTPException(500, f"Eval run failed: {exc}")
