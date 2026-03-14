"""Pipeline graph, node metrics, and critic analytics."""

from fastapi import APIRouter, Depends

from ..auth import UserInfo, get_current_user
from ..services import prometheus_client_svc as prom

router = APIRouter(prefix="/api/v1/pipeline", tags=["pipeline"])

GRAPH_DEFINITION = {
    "nodes": [
        {"id": "router", "label": "Router"},
        {"id": "planner", "label": "Planner"},
        {"id": "executor", "label": "Executor"},
        {"id": "writer", "label": "Writer"},
        {"id": "critic", "label": "Critic"},
        {"id": "final_answer", "label": "Final Answer"},
    ],
    "edges": [
        {"from": "router", "to": "planner"},
        {"from": "planner", "to": "executor"},
        {"from": "executor", "to": "writer"},
        {"from": "writer", "to": "critic"},
        {"from": "critic", "to": "writer", "label": "reject"},
        {"from": "critic", "to": "final_answer", "label": "approve"},
    ],
}


@router.get("/graph")
async def pipeline_graph(_user: UserInfo = Depends(get_current_user)):
    return GRAPH_DEFINITION


@router.get("/metrics")
async def pipeline_metrics(_user: UserInfo = Depends(get_current_user)):
    nodes = await prom.get_pipeline_node_metrics()
    return {"nodes": nodes}


@router.get("/critic")
async def critic_analytics(_user: UserInfo = Depends(get_current_user)):
    return await prom.get_critic_stats()
