"""Model registry, cost, and performance endpoints."""

from fastapi import APIRouter, Depends

from ..auth import UserInfo, get_current_user
from ..services.model_registry import get_model_registry, get_cost_estimates
from ..services import prometheus_client_svc as prom

router = APIRouter(prefix="/api/v1/models", tags=["models"])


@router.get("/")
async def list_models(_user: UserInfo = Depends(get_current_user)):
    return {"models": get_model_registry()}


@router.get("/costs")
async def model_costs(_user: UserInfo = Depends(get_current_user)):
    return {"roles": get_cost_estimates()}


@router.get("/performance")
async def model_performance(_user: UserInfo = Depends(get_current_user)):
    models = await prom.get_model_performance()
    return {"models": models, "period": "24h"}
