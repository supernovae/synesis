"""Internal service authentication helpers for control-plane endpoints.

Defense in depth: network policies should still restrict reachability, but
internal worker APIs also require a shared service token.
"""

from __future__ import annotations

import hmac
import os

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from .auth import UserInfo, get_current_user
from .rbac import Role, resolve_role

_bearer = HTTPBearer(auto_error=False)


class ServicePrincipal(BaseModel):
    service: str = "internal"


def _configured_service_tokens() -> list[str]:
    tokens: list[str] = []
    one = os.getenv("SYNESIS_INTERNAL_SERVICE_TOKEN", "").strip()
    if one:
        tokens.append(one)
    many = os.getenv("SYNESIS_INTERNAL_SERVICE_TOKENS", "").strip()
    if many:
        tokens.extend([t.strip() for t in many.split(",") if t.strip()])
    # Preserve order but de-duplicate.
    seen: set[str] = set()
    deduped: list[str] = []
    for t in tokens:
        if t in seen:
            continue
        seen.add(t)
        deduped.append(t)
    return deduped


def _matches_service_token(candidate: str) -> bool:
    if not candidate:
        return False
    for token in _configured_service_tokens():
        if hmac.compare_digest(candidate, token):
            return True
    return False


def require_internal_service_token_request(request: Request) -> ServicePrincipal:
    """Require a configured internal service token for ingest-only endpoints."""
    configured = _configured_service_tokens()
    if not configured:
        raise HTTPException(status_code=503, detail="Internal service token is not configured")
    token = (
        request.headers.get("x-synesis-service-token", "")
        or request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    ).strip()
    for expected in configured:
        if hmac.compare_digest(token, expected):
            return ServicePrincipal(service=_service_name_from_request(request))
    raise HTTPException(status_code=401, detail="Invalid service token")


def _service_name_from_request(request: Request) -> str:
    return (request.headers.get("x-synesis-service-name") or "internal").strip()[:128]


async def require_service_or_platform_admin(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> ServicePrincipal | UserInfo:
    """Allow either a configured service token or a platform_admin user token."""
    bearer = (credentials.credentials if credentials else "").strip()
    header = (request.headers.get("x-synesis-service-token") or "").strip()

    if _matches_service_token(header) or _matches_service_token(bearer):
        return ServicePrincipal(service=_service_name_from_request(request))

    if credentials:
        user = await get_current_user(request=request, credentials=credentials)
        if resolve_role(user) >= Role.platform_admin:
            return user
        raise HTTPException(status_code=403, detail="Requires platform_admin or internal service token")

    raise HTTPException(status_code=401, detail="Missing internal service token")


async def require_service_or_authenticated_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> ServicePrincipal | UserInfo:
    """Allow either a configured service token or any authenticated user token."""
    bearer = (credentials.credentials if credentials else "").strip()
    header = (request.headers.get("x-synesis-service-token") or "").strip()

    if _matches_service_token(header) or _matches_service_token(bearer):
        return ServicePrincipal(service=_service_name_from_request(request))

    try:
        return await get_current_user(request=request, credentials=credentials)
    except HTTPException as exc:
        if exc.status_code in {401, 403}:
            raise HTTPException(status_code=401, detail="Not authenticated") from exc
        raise
