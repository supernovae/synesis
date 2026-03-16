"""Pipeline graph, node metrics, and critic analytics."""

from fastapi import APIRouter, Depends, Query

from ..auth import UserInfo, get_current_user
from ..services import critic_analytics as critic_svc
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


@router.get("/critic/detailed")
async def critic_detailed(
    days: int = Query(7, ge=1, le=90),
    _user: UserInfo = Depends(get_current_user),
):
    """Critic analytics from Postgres traces (full_record JSONB)."""
    data = await critic_svc.get_critic_detailed(days)
    if data is not None:
        return data
    return {
        "period_days": days,
        "total_evaluated": 0,
        "approved": 0,
        "rejected": 0,
        "approval_rate": 0.0,
        "avg_scores": {},
        "score_distribution": [
            {"bucket": "0-3", "count": 0},
            {"bucket": "3-5", "count": 0},
            {"bucket": "5-7", "count": 0},
            {"bucket": "7-8", "count": 0},
            {"bucket": "8-10", "count": 0},
        ],
        "top_failure_modes": [],
        "rejection_reasons": [],
    }


@router.get("/critic")
async def critic_analytics(_user: UserInfo = Depends(get_current_user)):
    """Main critic stats: try Postgres detailed first, fall back to Prometheus."""
    data = await critic_svc.get_critic_detailed(7)
    if data is not None:
        total = data["total_evaluated"]
        return {
            "total_evaluations": total,
            "approval_rate": data["approval_rate"],
            "rejection_rate": data["rejected"] / total if total > 0 else 0.0,
            "avg_score": data["avg_scores"].get("weighted_overall", 0),
            "blocking_issues": data["rejected"],
        }
    return await prom.get_critic_stats()
