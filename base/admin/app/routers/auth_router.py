"""Auth endpoints: login, current user."""

from fastapi import APIRouter, Depends

from ..auth import LoginRequest, TokenResponse, UserInfo, authenticate, get_current_user

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
async def login(req: LoginRequest):
    return authenticate(req.username, req.password)


@router.get("/me", response_model=UserInfo)
async def me(user: UserInfo = Depends(get_current_user)):
    return user
