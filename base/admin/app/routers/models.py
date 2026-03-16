"""Model registry, cost, and performance endpoints."""

from fastapi import APIRouter, Body, Depends

from ..auth import UserInfo, get_current_user
from ..services import prometheus_client_svc as prom
from ..services.model_registry import (
    get_cost_by_model,
    get_cost_estimates,
    get_model_registry,
    upsert_model_cost,
)

router = APIRouter(prefix="/api/v1/models", tags=["models"])


@router.get("/")
async def list_models(_user: UserInfo = Depends(get_current_user)):
    return {"models": get_model_registry()}


@router.get("/costs")
async def model_costs(_user: UserInfo = Depends(get_current_user)):
    costs = await get_cost_estimates()
    return {"roles": costs}


@router.put("/costs")
async def update_model_cost(
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    result = await upsert_model_cost(data)
    return result


@router.get("/costs/by-model")
async def costs_by_model(_user: UserInfo = Depends(get_current_user)):
    return {"models": await get_cost_by_model(), "period": "7d"}


@router.get("/performance")
async def model_performance(_user: UserInfo = Depends(get_current_user)):
    models = await prom.get_model_performance()
    return {"models": models, "period": "24h"}
