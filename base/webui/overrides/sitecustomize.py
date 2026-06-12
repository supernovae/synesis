"""Synesis Open WebUI service-token bridge.

Open WebUI uses one global ENABLE_API_KEYS switch for both user API-key
creation and API-key authentication. Synesis needs an internal credential for
feedback export and message status events, but should not expose Open WebUI as
a general API-key gateway for users.

This sitecustomize module is loaded by Python before Open WebUI imports its app.
It patches Open WebUI's API-key resolver to accept one Helm-managed Synesis
service token on a narrow endpoint allow-list while ENABLE_API_KEYS remains
false for normal user-created keys.
"""

from __future__ import annotations

import logging
import os
import re
import secrets
from collections.abc import Awaitable, Callable

log = logging.getLogger("synesis.openwebui.service_auth")

SERVICE_TOKEN = os.getenv("SYNESIS_OPENWEBUI_SERVICE_TOKEN", "").strip()
SERVICE_EMAIL = (
    os.getenv("SYNESIS_OPENWEBUI_SERVICE_EMAIL", "").strip().lower() or "synesis-openwebui-service@localhost"
)
SERVICE_NAME = os.getenv("SYNESIS_OPENWEBUI_SERVICE_NAME", "").strip() or "Synesis Open WebUI Service"

_ALLOWED_ENDPOINTS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("GET", re.compile(r"^/api/v1/evaluations/feedbacks/all(?:/export)?$")),
    ("POST", re.compile(r"^/api/v1/chats/[^/]+/messages/[^/]+/event$")),
)

if SERVICE_TOKEN:
    try:
        import open_webui.utils.auth as owui_auth
        from fastapi import HTTPException, status
        from open_webui.constants import ERROR_MESSAGES
        from open_webui.models.auths import Auths
        from open_webui.models.users import UserModel, Users
    except Exception:
        log.exception("failed to enable Synesis Open WebUI service-token bridge")
    else:
        _original_get_current_user_by_api_key: Callable[[object, str], Awaitable[UserModel]] = (
            owui_auth.get_current_user_by_api_key
        )

        def _is_allowed_service_request(request: object) -> bool:
            scope = getattr(request, "scope", {}) or {}
            method = str(scope.get("method") or "").upper()
            path = str(scope.get("path") or "")
            return any(
                method == allowed_method and pattern.match(path) for allowed_method, pattern in _ALLOWED_ENDPOINTS
            )

        async def _get_or_create_service_user() -> UserModel:
            user = await Users.get_user_by_email(SERVICE_EMAIL)
            if user:
                if user.role != "admin":
                    promoted = await Users.update_user_role_by_id(user.id, "admin")
                    return promoted or user
                return user

            password = owui_auth.get_password_hash(secrets.token_urlsafe(48))
            created = await Auths.insert_new_auth(
                email=SERVICE_EMAIL,
                password=password,
                name=SERVICE_NAME,
                role="admin",
            )
            if not created:
                raise HTTPException(status_code=500, detail=ERROR_MESSAGES.DEFAULT())
            log.info("created Synesis Open WebUI service user")
            return created

        async def _synesis_get_current_user_by_api_key(request: object, api_key: str) -> UserModel:
            if api_key == SERVICE_TOKEN:
                if not _is_allowed_service_request(request):
                    raise HTTPException(status.HTTP_403_FORBIDDEN, detail=ERROR_MESSAGES.ACCESS_PROHIBITED)
                return await _get_or_create_service_user()
            return await _original_get_current_user_by_api_key(request, api_key)

        owui_auth.get_current_user_by_api_key = _synesis_get_current_user_by_api_key
        log.info("enabled Synesis Open WebUI service-token bridge")
