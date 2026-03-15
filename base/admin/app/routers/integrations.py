"""MCP tools and web search integration stats."""

from fastapi import APIRouter, Depends

from ..auth import UserInfo, get_current_user
from ..services import prometheus_client_svc as prom
from ..services.mcp_client import get_mcp_tools

router = APIRouter(prefix="/api/v1/integrations", tags=["integrations"])


@router.get("/mcp/tools")
async def mcp_tools(_user: UserInfo = Depends(get_current_user)):
    tools = await get_mcp_tools()
    return {"tools": tools}


@router.get("/web-search")
async def web_search_stats(_user: UserInfo = Depends(get_current_user)):
    raw = await prom.fetch_planner_metrics()
    total = prom._find_metric(raw, "synesis_web_search_total")
    return {
        "total": int(total),
        "avg_latency_ms": 0,
        "error_rate": 0,
    }
