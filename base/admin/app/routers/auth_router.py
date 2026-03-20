"""Auth endpoints: login, current user, OIDC config discovery."""

import logging
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import (
    KEYCLOAK_ISSUER,
    LoginRequest,
    TokenResponse,
    UserInfo,
    authenticate,
    get_current_user,
)

logger = logging.getLogger("synesis.auth.router")

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class OidcTokenExchangeRequest(BaseModel):
    """Browser sends PKCE verifier here; server exchanges the code with Keycloak.

    Avoids calling Keycloak's token endpoint from the browser (CORS / CORP issues).
    """

    code: str = Field(..., min_length=1)
    redirect_uri: str = Field(..., min_length=1)
    code_verifier: str = Field(..., min_length=1)


class OidcRefreshRequest(BaseModel):
    refresh_token: str = Field(..., min_length=1)


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


@router.post("/oauth/token")
async def oauth_token_exchange(req: OidcTokenExchangeRequest):
    """Exchange an authorization code for tokens (Keycloak, public client + PKCE)."""
    if not KEYCLOAK_ISSUER:
        raise HTTPException(status_code=400, detail="OIDC is not configured")

    internal = os.getenv("SYNESIS_KEYCLOAK_INTERNAL_ISSUER_URL", "").strip().rstrip("/")
    token_base = internal or KEYCLOAK_ISSUER.rstrip("/")
    token_url = f"{token_base}/protocol/openid-connect/token"
    body = {
        "grant_type": "authorization_code",
        "client_id": "synesis-admin",
        "code": req.code,
        "redirect_uri": req.redirect_uri,
        "code_verifier": req.code_verifier,
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                token_url,
                data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
    except httpx.RequestError as exc:
        logger.warning("keycloak_token_exchange_transport_error", exc_info=True)
        raise HTTPException(
            status_code=502, detail="Could not reach identity provider"
        ) from exc

    if r.status_code != 200:
        logger.warning(
            "keycloak_token_exchange_failed status=%s body=%s",
            r.status_code,
            (r.text or "")[:800],
        )
        raise HTTPException(
            status_code=400,
            detail="Token exchange failed — check redirect URI and Keycloak client",
        )

    data = r.json()
    access = data.get("access_token")
    if not access or not isinstance(access, str):
        raise HTTPException(status_code=400, detail="Invalid token response")
    result: dict = {
        "access_token": access,
        "token_type": data.get("token_type", "bearer"),
    }
    if data.get("refresh_token"):
        result["refresh_token"] = data["refresh_token"]
    if data.get("expires_in"):
        result["expires_in"] = data["expires_in"]
    if data.get("id_token"):
        result["id_token"] = data["id_token"]
    return result


@router.post("/oauth/refresh")
async def oauth_refresh(req: OidcRefreshRequest):
    """Use a refresh token to obtain a new access token without a full redirect."""
    if not KEYCLOAK_ISSUER:
        raise HTTPException(status_code=400, detail="OIDC is not configured")

    internal = os.getenv("SYNESIS_KEYCLOAK_INTERNAL_ISSUER_URL", "").strip().rstrip("/")
    token_base = internal or KEYCLOAK_ISSUER.rstrip("/")
    token_url = f"{token_base}/protocol/openid-connect/token"
    body = {
        "grant_type": "refresh_token",
        "client_id": "synesis-admin",
        "refresh_token": req.refresh_token,
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                token_url,
                data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
    except httpx.RequestError as exc:
        logger.debug("keycloak_refresh_transport_error", exc_info=True)
        raise HTTPException(
            status_code=502, detail="Could not reach identity provider"
        ) from exc

    if r.status_code != 200:
        logger.debug(
            "keycloak_refresh_failed status=%s body=%s",
            r.status_code,
            (r.text or "")[:400],
        )
        raise HTTPException(status_code=401, detail="Refresh token expired or revoked")

    data = r.json()
    access = data.get("access_token")
    if not access:
        raise HTTPException(status_code=400, detail="Invalid refresh response")
    result: dict = {
        "access_token": access,
        "token_type": data.get("token_type", "bearer"),
    }
    if data.get("refresh_token"):
        result["refresh_token"] = data["refresh_token"]
    if data.get("expires_in"):
        result["expires_in"] = data["expires_in"]
    if data.get("id_token"):
        result["id_token"] = data["id_token"]
    return result
