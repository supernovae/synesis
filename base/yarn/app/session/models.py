"""Pydantic models for session state and related types."""

from __future__ import annotations

import time
from typing import Any

from pydantic import BaseModel, Field


class RateLimits(BaseModel):
    tokens_per_minute: int = 500_000
    requests_per_minute: int = 60
    tokens_used_this_minute: int = 0
    requests_used_this_minute: int = 0
    window_start: float = Field(default_factory=time.time)


class SessionState(BaseModel):
    session_key: str
    user_id: str
    org_id: str = ""
    username: str = ""
    role: str = "user"
    conversation_id: str = ""
    tool_permissions: list[str] = Field(default_factory=lambda: ["*"])
    rate_limits: RateLimits = Field(default_factory=RateLimits)
    created_at: float = Field(default_factory=time.time)
    last_active_at: float = Field(default_factory=time.time)
    total_tokens_in: int = 0
    total_tokens_out: int = 0
    total_tokens_cached: int = 0
    request_count: int = 0
    escalation_count: int = 0
    metadata: dict[str, Any] = Field(default_factory=dict)


class AuthUser(BaseModel):
    """Resolved identity from JWT or PAT."""

    user_id: str
    org_id: str = ""
    username: str = ""
    role: str = "user"
    auth_method: str = "pat"  # "keycloak" | "pat" | "legacy"
