"""JWT authentication with dummy users. SSO-ready via OIDC placeholder."""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

SECRET_KEY = os.getenv("SYNESIS_JWT_SECRET", "synesis-dev-secret-change-me")
TOKEN_EXPIRY_HOURS = int(os.getenv("SYNESIS_TOKEN_EXPIRY_HOURS", "24"))

USERS: dict[str, dict] = {
    "admin": {
        "password": os.getenv("SYNESIS_ADMIN_PASSWORD", "admin"),
        "role": "admin",
    },
    "viewer": {
        "password": os.getenv("SYNESIS_VIEWER_PASSWORD", "viewer"),
        "role": "readonly",
    },
}


class LoginRequest(BaseModel):
    username: str
    password: str


class UserInfo(BaseModel):
    username: str
    role: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"  # noqa: S105 — standard OAuth2 field, not a password
    user: UserInfo


def create_token(username: str, role: str) -> str:
    payload = {
        "sub": username,
        "role": role,
        "exp": datetime.now(UTC) + timedelta(hours=TOKEN_EXPIRY_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


def verify_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=["HS256"])


_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> UserInfo:
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = verify_token(credentials.credentials)
        return UserInfo(username=payload["sub"], role=payload["role"])
    except jwt.ExpiredSignatureError as err:
        raise HTTPException(status_code=401, detail="Token expired") from err
    except jwt.InvalidTokenError as err:
        raise HTTPException(status_code=401, detail="Invalid token") from err


async def require_admin(user: UserInfo = Depends(get_current_user)) -> UserInfo:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def authenticate(username: str, password: str) -> TokenResponse:
    entry = USERS.get(username)
    if not entry or entry["password"] != password:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_token(username, entry["role"])
    return TokenResponse(
        access_token=token,
        user=UserInfo(username=username, role=entry["role"]),
    )
