"""Planner usage log ingest (service token) — metering without traces."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request

from ..deps import INTERNAL_SERVICE_TOKEN
from ..services.planner_usage_service import upsert_metering_row

logger = logging.getLogger("synesis.admin.planner_usage_router")

router = APIRouter(prefix="/api/v1/planner/usage", tags=["planner-usage"])


def _verify_service_token(request: Request) -> None:
    if not INTERNAL_SERVICE_TOKEN:
        return
    token = (
        request.headers.get("x-synesis-service-token", "")
        or request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    )
    if token != INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid service token")


@router.post("/metering")
async def ingest_planner_metering(request: Request, body: dict[str, Any] = Body(...)):
    """Accept one planner pipeline metering row from planner-ts (fire-and-forget)."""
    _verify_service_token(request)
    await upsert_metering_row(body)
    rid = (body.get("request_id") or body.get("trace_id") or "")[:64]
    return {"status": "ok", "request_id": rid}
