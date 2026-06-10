"""Auth endpoints: login, current user, OIDC config discovery."""

import logging
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ..auth import (
    KEYCLOAK_ISSUER,
    UserInfo,
    create_admin_session,
    get_current_user,
    refresh_admin_session,
    revoke_current_admin_session,
    validate_session_csrf,
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


@router.get("/me", response_model=UserInfo)
async def me(user: UserInfo = Depends(get_current_user)):
    return user


@router.get("/oidc-config")
async def oidc_config():
    """Return OIDC configuration for the frontend to discover Keycloak.

    When Keycloak is not configured, returns enabled=false — the UI shows
    setup instructions (no local password login).
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
async def oauth_token_exchange(req: OidcTokenExchangeRequest, request: Request, response: Response):
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
        logger.warning("identity_provider_transport_error", exc_info=True)
        raise HTTPException(status_code=502, detail="Could not reach identity provider") from exc

    if r.status_code != 200:
        logger.warning(
            "identity_provider_http_error status=%s response_snippet=%s",
            r.status_code,
            (r.text or "")[:800],
        )
        raise HTTPException(
            status_code=400,
            detail="Token exchange failed — check redirect URI and Keycloak client",
        )

    user = await create_admin_session(request, response, r.json())
    return {"status": "ok", "user": user.model_dump()}


@router.post("/oauth/refresh")
async def oauth_refresh(request: Request, response: Response, req: OidcRefreshRequest | None = None):
    """Use a refresh token to obtain a new access token without a full redirect."""
    if not KEYCLOAK_ISSUER:
        raise HTTPException(status_code=400, detail="OIDC is not configured")

    internal = os.getenv("SYNESIS_KEYCLOAK_INTERNAL_ISSUER_URL", "").strip().rstrip("/")
    token_base = internal or KEYCLOAK_ISSUER.rstrip("/")
    token_url = f"{token_base}/protocol/openid-connect/token"
    refresh_token = req.refresh_token if req is not None else ""
    if not refresh_token:
        from sqlalchemy import select

        from ..auth import SESSION_COOKIE_NAME, _hash_session_id, _is_valid_session_id
        from ..db.engine import async_session
        from ..db.models import AdminSession
        from ..session_crypto import decrypt_session_token

        session_id = request.cookies.get(SESSION_COOKIE_NAME, "")
        if not session_id or not _is_valid_session_id(session_id):
            raise HTTPException(status_code=401, detail="Not authenticated")
        async with async_session() as session:
            row = (
                await session.execute(
                    select(AdminSession).where(AdminSession.session_hash == _hash_session_id(session_id))
                )
            ).scalar_one_or_none()
            if not row or row.revoked_at is not None or not row.refresh_token:
                raise HTTPException(status_code=401, detail="Not authenticated")
            validate_session_csrf(request, row.csrf_token)
            try:
                refresh_token = decrypt_session_token(row.refresh_token)
            except (RuntimeError, ValueError) as exc:
                logger.warning("admin_session_refresh_token_decrypt_failed")
                raise HTTPException(status_code=401, detail="Not authenticated") from exc

    body = {
        "grant_type": "refresh_token",
        "client_id": "synesis-admin",
        "refresh_token": refresh_token,
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
        raise HTTPException(status_code=502, detail="Could not reach identity provider") from exc

    if r.status_code != 200:
        logger.debug(
            "keycloak_refresh_failed status=%s body=%s",
            r.status_code,
            (r.text or "")[:400],
        )
        raise HTTPException(status_code=401, detail="Refresh token expired or revoked")

    user = await refresh_admin_session(request, response, r.json())
    return {"status": "ok", "user": user.model_dump()}


@router.post("/logout")
async def logout(request: Request, response: Response, _user: UserInfo = Depends(get_current_user)):
    await revoke_current_admin_session(request, response)
    return {"status": "ok"}
