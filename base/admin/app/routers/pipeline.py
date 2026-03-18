"""Pipeline graph, node metrics, and critic analytics."""

from fastapi import APIRouter, Depends, Query

from ..auth import UserInfo, get_current_user
from ..services import critic_analytics as critic_svc
from ..services import prometheus_client_svc as prom

router = APIRouter(prefix="/api/v1/pipeline", tags=["pipeline"])

GRAPH_DEFINITION = {
    "nodes": [
        {"id": "entry_pipeline", "label": "Entry Pipeline", "type": "entry"},
        {"id": "router", "label": "Router", "type": "retrieval"},
        {"id": "planner", "label": "Planner", "type": "planning"},
        {"id": "executor", "label": "Executor", "type": "execution"},
        {"id": "writer", "label": "Writer", "type": "generation"},
        {"id": "patch_integrity_gate", "label": "Patch Integrity", "type": "validation"},
        {"id": "critic", "label": "Critic", "type": "evaluation"},
        {"id": "final_scrubber", "label": "Final Scrubber", "type": "post"},
        {"id": "respond", "label": "Respond", "type": "terminal"},
    ],
    "edges": [
        {"from": "entry_pipeline", "to": "router", "label": "route"},
        {"from": "entry_pipeline", "to": "writer", "label": "direct write"},
        {"from": "entry_pipeline", "to": "executor", "label": "direct exec"},
        {"from": "entry_pipeline", "to": "respond", "label": "trivial"},
        {"from": "router", "to": "planner", "label": "plan"},
        {"from": "router", "to": "executor", "label": "execute"},
        {"from": "router", "to": "writer", "label": "write"},
        {"from": "router", "to": "respond", "label": "done"},
        {"from": "planner", "to": "router", "label": "evidence gap"},
        {"from": "planner", "to": "writer", "label": "write"},
        {"from": "planner", "to": "executor", "label": "execute"},
        {"from": "planner", "to": "respond", "label": "done"},
        {"from": "executor", "to": "patch_integrity_gate", "label": "verify"},
        {"from": "executor", "to": "respond", "label": "done"},
        {"from": "writer", "to": "critic", "label": "evaluate"},
        {"from": "writer", "to": "final_scrubber", "label": "skip critic"},
        {"from": "patch_integrity_gate", "to": "router", "label": "retry"},
        {"from": "patch_integrity_gate", "to": "critic", "label": "evaluate"},
        {"from": "critic", "to": "writer", "label": "revise"},
        {"from": "critic", "to": "router", "label": "evidence gap"},
        {"from": "critic", "to": "final_scrubber", "label": "approve"},
        {"from": "critic", "to": "respond", "label": "done"},
        {"from": "final_scrubber", "to": "respond"},
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


@router.get("/critic/evaluations")
async def critic_evaluations(
    days: int = Query(7, ge=1, le=90),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _user: UserInfo = Depends(get_current_user),
):
    """Paginated list of individual critic evaluations."""
    data = await critic_svc.get_critic_evaluations(days, limit, offset)
    if data is not None:
        return data
    return {"evaluations": [], "total": 0, "limit": limit, "offset": offset}


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
