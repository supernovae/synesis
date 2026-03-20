"""System configuration and infrastructure cost settings."""

import logging
import os

from fastapi import APIRouter, Body, Depends, HTTPException

from ..auth import UserInfo, get_current_user
from ..services.infra_pricing import (
    delete_infra_config,
    get_infra_configs,
    get_instance_catalog,
    upsert_infra_config,
)

logger = logging.getLogger("synesis.admin.settings")

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])

PUBLIC_ENV_PREFIXES = (
    "SYNESIS_MILVUS_",
    "SYNESIS_PLANNER_",
    "SYNESIS_LITELLM_",
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


@router.get("/config")
async def system_config(_user: UserInfo = Depends(get_current_user)):
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
    role: str,
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    """Create or update infra cost config for a role."""
    data["role"] = role
    result = await upsert_infra_config(data)
    return result


@router.delete("/infra-costs/{role}")
async def remove_infra_cost(
    role: str,
    _user: UserInfo = Depends(get_current_user),
):
    """Delete infra cost config for a role."""
    ok = await delete_infra_config(role)
    if not ok:
        raise HTTPException(404, f"No infra config for role: {role}")
    return {"deleted": role}
