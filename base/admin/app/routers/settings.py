"""Read-only system configuration view."""

import os

from fastapi import APIRouter, Depends

from ..auth import UserInfo, get_current_user

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])

PUBLIC_ENV_PREFIXES = (
    "SYNESIS_MILVUS_",
    "SYNESIS_PLANNER_",
    "SYNESIS_LITELLM_",
    "SYNESIS_MCP_",
    "SYNESIS_EMBEDDER_",
    "SYNESIS_KEYWORD_",
    "SYNESIS_LOG_",
    "SYNESIS_OPIK_",
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
