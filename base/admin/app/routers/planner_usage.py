"""Planner usage log ingest (service token) — metering without traces."""

from __future__ import annotations

import logging
from typing import Literal, Self

from fastapi import APIRouter, Body, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..internal_auth import require_internal_service_token_request
from ..services.planner_usage_service import upsert_metering_row

logger = logging.getLogger("synesis.admin.planner_usage_router")

router = APIRouter(prefix="/api/v1/planner/usage", tags=["planner-usage"])


class PlannerMeteringRatesSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input_per_million: float = Field(0, ge=0, le=1_000_000)
    output_per_million: float = Field(0, ge=0, le=1_000_000)
    cached_input_per_million: float | None = Field(None, ge=0, le=1_000_000)
    cache_write_input_per_million: float | None = Field(None, ge=0, le=1_000_000)
    input_cached_per_million: float | None = Field(None, ge=0, le=1_000_000)
    input_cache_write_per_million: float | None = Field(None, ge=0, le=1_000_000)


class PlannerMeteringBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    request_id: str | None = Field(None, min_length=1, max_length=64)
    trace_id: str | None = Field(None, min_length=1, max_length=64)
    user_id: str = Field("", max_length=256)
    org_id: str = Field("", max_length=256)
    tenant_id: str = Field("", max_length=64)
    conversation_id: str = Field("", max_length=128)
    model: str = Field("", max_length=256)
    tokens_in: int = Field(0, ge=0, le=10_000_000_000)
    tokens_out: int = Field(0, ge=0, le=10_000_000_000)
    tokens_cached: int = Field(0, ge=0, le=10_000_000_000)
    tokens_cache_write: int = Field(0, ge=0, le=10_000_000_000)
    estimated_cost_usd: float = Field(0, ge=0, le=1_000_000_000)
    actual_cost_usd: float = Field(0, ge=0, le=1_000_000_000)
    input_cost_usd: float = Field(0, ge=0, le=1_000_000_000)
    cache_read_cost_usd: float = Field(0, ge=0, le=1_000_000_000)
    cache_write_cost_usd: float = Field(0, ge=0, le=1_000_000_000)
    output_cost_usd: float = Field(0, ge=0, le=1_000_000_000)
    estimated_no_cache_cost_usd: float = Field(0, ge=0, le=1_000_000_000)
    cache_savings_usd: float = Field(0, ge=0, le=1_000_000_000)
    pricing_source: Literal[
        "provider", "manual", "infra_calc", "api_lookup", "fallback_base", "registry", "unknown"
    ] = "unknown"
    auth_method: str = Field("", max_length=32)
    auth_key_id: str = Field("", max_length=128)
    auth_key_name: str = Field("", max_length=256)
    auth_key_prefix: str = Field("", max_length=32)
    rates_snapshot: PlannerMeteringRatesSnapshot | None = None
    latency_ms: float = Field(0, ge=0, le=86_400_000)
    has_error: bool = False

    @model_validator(mode="after")
    def require_request_or_trace_id(self) -> Self:
        if not (self.request_id or self.trace_id):
            raise ValueError("request_id or trace_id is required")
        return self


@router.post("/metering")
async def ingest_planner_metering(request: Request, body: PlannerMeteringBody = Body(...)):
    """Accept one planner pipeline metering row from planner-ts (fire-and-forget)."""
    require_internal_service_token_request(request)
    record = body.model_dump(exclude_none=True)
    await upsert_metering_row(record)
    rid = (record.get("request_id") or record.get("trace_id") or "")[:64]
    return {"status": "ok", "request_id": rid}
