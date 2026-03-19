"""Auth endpoints: login, current user, OIDC config discovery."""

from fastapi import APIRouter, Depends

from ..auth import (
    KEYCLOAK_ISSUER,
    LoginRequest,
    TokenResponse,
    UserInfo,
    authenticate,
    get_current_user,
)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
async def login(req: LoginRequest):
    """Local login — disabled when Keycloak is configured."""
    return authenticate(req.username, req.password)


@router.get("/me", response_model=UserInfo)
async def me(user: UserInfo = Depends(get_current_user)):
    return user


@router.get("/oidc-config")
async def oidc_config():
    """Return OIDC configuration for the frontend to discover Keycloak.

    When Keycloak is not configured, returns enabled=false so the frontend
    knows to show the legacy username/password form.
    """
    if not KEYCLOAK_ISSUER:
        return {"enabled": False}
    return {
        "enabled": True,
        "issuer": KEYCLOAK_ISSUER,
        "client_id": "synesis-admin",
        "scopes": "openid profile email",
    }
