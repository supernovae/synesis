"""System configuration and infrastructure cost settings."""

import logging
import os

from fastapi import APIRouter, Body, Depends, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field

from ..auth import UserInfo, get_current_user
from ..rbac import require_platform_admin
from ..services.admin_audit import record_admin_audit
from ..services.infra_pricing import (
    delete_infra_config,
    get_infra_configs,
    get_instance_catalog,
    upsert_infra_config,
)

logger = logging.getLogger("synesis.admin.settings")

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])

PUBLIC_ENV_PREFIXES = (
    "SYNESIS_NORNIC_",
    "SYNESIS_PLANNER_",
    "SYNESIS_MCP_",
    "SYNESIS_EMBEDDER_",
    "SYNESIS_KEYWORD_",
    "SYNESIS_LOG_",
    "SYNESIS_TRACE_",
    "SYNESIS_ADMIN_",
    "SYNESIS_MODELS_",
    "SYNESIS_TAXONOMY_",
)

REDACTED_PATTERNS = ("PASSWORD", "SECRET", "TOKEN", "KEY")


class InfraCostConfigBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cloud: str = Field("", max_length=32)
    instance_type: str = Field("", max_length=128)
    gpu_model: str = Field("", max_length=64)
    gpu_count: int = Field(0, ge=0, le=1024)
    hourly_rate: float = Field(0, ge=0, le=1_000_000)
    tokens_per_hour: int = Field(0, ge=0, le=10_000_000_000_000)
    notes: str = Field("", max_length=4000)


@router.get("/config")
async def system_config(_user: UserInfo = Depends(require_platform_admin)):
    config = {}
    for key, val in sorted(os.environ.items()):
        if not key.startswith("SYNESIS_"):
            continue
        if any(p in key.upper() for p in REDACTED_PATTERNS):
            config[key] = "***"
        else:
            config[key] = val
    return {"config": config}


# ---------------------------------------------------------------------------
# Infrastructure cost configuration
# ---------------------------------------------------------------------------


@router.get("/infra-costs/catalog")
async def infra_instance_catalog(_user: UserInfo = Depends(get_current_user)):
    """Return the pre-populated instance type catalog."""
    return {"instances": get_instance_catalog()}


@router.get("/infra-costs")
async def list_infra_costs(_user: UserInfo = Depends(get_current_user)):
    """Return saved infra cost configs (one per role)."""
    return {"configs": await get_infra_configs()}


@router.put("/infra-costs/{role}")
async def set_infra_cost(
    role: str = Path(..., min_length=1, max_length=64),
    body: InfraCostConfigBody = Body(...),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Create or update infra cost config for a role."""
    data = body.model_dump()
    data["role"] = role
    result = await upsert_infra_config(data)
    await record_admin_audit(
        user=_user,
        action="settings.infra_cost_upsert",
        status="success",
        summary=f"Updated infra cost config for role {role}",
        detail={"role": role, "config": result},
    )
    return result


@router.delete("/infra-costs/{role}")
async def remove_infra_cost(
    role: str = Path(..., min_length=1, max_length=64),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Delete infra cost config for a role."""
    ok = await delete_infra_config(role)
    if not ok:
        raise HTTPException(404, f"No infra config for role: {role}")
    await record_admin_audit(
        user=_user,
        action="settings.infra_cost_delete",
        status="success",
        summary=f"Deleted infra cost config for role {role}",
        detail={"role": role},
    )
    return {"deleted": role}
