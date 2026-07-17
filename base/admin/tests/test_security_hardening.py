"""Focused regressions for admin security hardening helpers."""

from __future__ import annotations

import pytest
from fastapi import HTTPException, Request


def _request(headers: list[tuple[bytes, bytes]] | None = None, client: tuple[str, int] | None = None) -> Request:
    scope = {"type": "http", "method": "POST", "headers": headers or []}
    if client is not None:
        scope["client"] = client
    return Request(scope)


def test_internal_service_token_fails_closed_when_unconfigured(monkeypatch):
    from app.internal_auth import require_internal_service_token_request

    monkeypatch.delenv("SYNESIS_INTERNAL_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("SYNESIS_INTERNAL_SERVICE_TOKENS", raising=False)

    with pytest.raises(HTTPException) as exc:
        require_internal_service_token_request(_request())

    assert exc.value.status_code == 503


def test_rag_review_filter_rejects_control_characters():
    from app.routers.rag import _clean_review_filter_value

    with pytest.raises(HTTPException) as exc:
        _clean_review_filter_value("python\nadmin", name="domain")

    assert exc.value.status_code == 400


def test_internal_service_token_accepts_configured_header(monkeypatch):
    from app.internal_auth import require_internal_service_token_request

    monkeypatch.setenv("SYNESIS_INTERNAL_SERVICE_TOKEN", "svc-secret")
    principal = require_internal_service_token_request(
        _request([(b"x-synesis-service-token", b"svc-secret"), (b"x-synesis-service-name", b"planner")])
    )

    assert principal.service == "planner"


def test_internal_service_token_accepts_case_insensitive_bearer(monkeypatch):
    from app.internal_auth import require_internal_service_token_request

    monkeypatch.setenv("SYNESIS_INTERNAL_SERVICE_TOKEN", "svc-secret")
    principal = require_internal_service_token_request(
        _request([(b"authorization", b"bearer svc-secret"), (b"x-synesis-service-name", b"planner")])
    )

    assert principal.service == "planner"


def test_internal_service_token_rejects_malformed_service_name(monkeypatch):
    from app.internal_auth import require_internal_service_token_request

    monkeypatch.setenv("SYNESIS_INTERNAL_SERVICE_TOKEN", "svc-secret")

    with pytest.raises(HTTPException) as exc:
        require_internal_service_token_request(
            _request(
                [
                    (b"x-synesis-service-token", b"svc-secret"),
                    (b"x-synesis-service-name", b"planner\nrole=admin"),
                ]
            )
        )

    assert exc.value.status_code == 400
    assert "service_name" in str(exc.value.detail)


def test_internal_service_token_rejects_non_bearer_authorization(monkeypatch):
    from app.internal_auth import require_internal_service_token_request

    monkeypatch.setenv("SYNESIS_INTERNAL_SERVICE_TOKEN", "svc-secret")

    with pytest.raises(HTTPException) as exc:
        require_internal_service_token_request(_request([(b"authorization", b"Basic svc-secret")]))

    assert exc.value.status_code == 401


def test_public_https_url_blocks_private_resolution(monkeypatch):
    from app.services.outbound_security import validate_public_https_url

    monkeypatch.setattr(
        "app.services.outbound_security.socket.getaddrinfo",
        lambda *a, **kw: [(None, None, None, None, ("10.0.0.5", 443))],
    )

    with pytest.raises(HTTPException) as exc:
        validate_public_https_url("https://catalog.example.com", field_name="base_url")

    assert exc.value.status_code == 400
    assert "blocked network" in str(exc.value.detail)


def test_public_https_url_enforces_allowlist(monkeypatch):
    from app.services.outbound_security import validate_public_https_url

    monkeypatch.setenv("SYNESIS_ADMIN_OUTBOUND_HOST_ALLOWLIST", "trusted.example")
    monkeypatch.setattr(
        "app.services.outbound_security.socket.getaddrinfo",
        lambda *a, **kw: [(None, None, None, None, ("93.184.216.34", 443))],
    )

    assert validate_public_https_url("https://catalog.trusted.example/path#fragment") == (
        "https://catalog.trusted.example/path"
    )
    with pytest.raises(HTTPException) as exc:
        validate_public_https_url("https://catalog.evil.example")

    assert exc.value.status_code == 400
    assert "allowlisted" in str(exc.value.detail)


def test_admin_session_ids_are_strictly_opaque_cookie_values():
    from app.auth import _is_valid_session_id, _new_session_id

    generated = _new_session_id()

    assert _is_valid_session_id(generated)
    assert not _is_valid_session_id("")
    assert not _is_valid_session_id("short")
    assert not _is_valid_session_id("session-id; SameSite=None")
    assert not _is_valid_session_id("session-id\r\nSet-Cookie: injected=1")


def test_client_ip_ignores_forwarded_for_without_trusted_proxy(monkeypatch):
    from app import request_ip

    request_ip._trusted_proxy_networks.cache_clear()
    monkeypatch.delenv("SYNESIS_TRUSTED_PROXY_CIDRS", raising=False)

    try:
        resolved = request_ip.get_client_ip(_request([(b"x-forwarded-for", b"203.0.113.7")], client=("10.0.0.10", 443)))
    finally:
        request_ip._trusted_proxy_networks.cache_clear()

    assert resolved == "10.0.0.10"


def test_client_ip_accepts_forwarded_for_from_trusted_proxy(monkeypatch):
    from app import request_ip

    request_ip._trusted_proxy_networks.cache_clear()
    monkeypatch.setenv("SYNESIS_TRUSTED_PROXY_CIDRS", "10.0.0.0/24")

    try:
        resolved = request_ip.get_client_ip(
            _request([(b"x-forwarded-for", b"203.0.113.7, 10.0.0.10")], client=("10.0.0.10", 443))
        )
    finally:
        request_ip._trusted_proxy_networks.cache_clear()

    assert resolved == "203.0.113.7"


def test_session_token_crypto_encrypts_with_configured_key(monkeypatch):
    from app import session_crypto

    monkeypatch.setenv("SYNESIS_ADMIN_SESSION_TOKEN_KEY", "test-session-token-key")
    encrypted = session_crypto.encrypt_session_token("refresh-secret")

    assert encrypted != "refresh-secret"
    assert session_crypto.is_encrypted_session_token(encrypted)
    assert session_crypto.decrypt_session_token(encrypted) == "refresh-secret"


def test_session_token_crypto_requires_key_when_enforced(monkeypatch):
    from app import session_crypto

    monkeypatch.delenv("SYNESIS_ADMIN_SESSION_TOKEN_KEY", raising=False)
    monkeypatch.setenv("SYNESIS_ADMIN_REQUIRE_SESSION_TOKEN_ENCRYPTION", "true")

    with pytest.raises(RuntimeError, match="SYNESIS_ADMIN_SESSION_TOKEN_KEY"):
        session_crypto.encrypt_session_token("refresh-secret")


def test_production_database_url_rejects_placeholder(monkeypatch):
    from app.config_safety import require_production_database_url

    monkeypatch.setenv("SYNESIS_ENV", "production")

    with pytest.raises(RuntimeError, match="SYNESIS_ADMIN_DATABASE_URL"):
        require_production_database_url(
            "SYNESIS_ADMIN_DATABASE_URL",
            "postgresql+asyncpg://app:changeme@synesis-admin-db-rw/synesis_admin",
        )


def test_security_headers_middleware_sets_browser_headers():
    import anyio
    from app.security_headers import SecurityHeadersMiddleware
    from starlette.responses import Response

    async def _run():
        async def _call_next(_req):
            return Response("ok")

        middleware = SecurityHeadersMiddleware(app=lambda scope, receive, send: None)
        return await middleware.dispatch(_request(client=("198.51.100.10", 443)), _call_next)

    response = anyio.run(_run)

    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["Content-Security-Policy"] == "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
    assert response.headers["Strict-Transport-Security"] == "max-age=31536000; includeSubDomains"


def test_admin_mcp_client_uses_internal_token_and_delegated_cookie(monkeypatch):
    from app.services import admin_mcp_ts_client

    monkeypatch.setattr(admin_mcp_ts_client, "INTERNAL_SERVICE_TOKEN", "internal-secret")
    headers = admin_mcp_ts_client._base_headers(
        "",
        {"x-active-org-id": "org-1"},
        session_cookie="a" * 43,
        csrf_cookie="b" * 64,
        csrf_token="b" * 64,
    )

    assert headers["x-synesis-service-token"] == "internal-secret"
    assert headers["x-synesis-service-name"] == "synesis-admin"
    assert headers["x-synesis-delegated-cookie"] == (f"synesis_admin_session={'a' * 43}; synesis_admin_csrf={'b' * 64}")
    assert headers["x-synesis-delegated-csrf"] == "b" * 64
    assert headers["x-active-org-id"] == "org-1"
    assert "Authorization" not in headers


def test_admin_mcp_client_rejects_malformed_org_header(monkeypatch):
    from app.services import admin_mcp_ts_client

    monkeypatch.setattr(admin_mcp_ts_client, "INTERNAL_SERVICE_TOKEN", "internal-secret")

    with pytest.raises(ValueError, match="x-active-org-id"):
        admin_mcp_ts_client._base_headers("", {"x-active-org-id": "org-1\nrole=admin"})


def test_assistant_planner_headers_reject_malformed_org_header():
    from app.routers.assistant import _planner_headers

    with pytest.raises(HTTPException) as exc:
        _planner_headers("", {"x-synesis-org-id": "org-1\nrole=admin"})

    assert exc.value.status_code == 422


def test_integrations_org_headers_reject_malformed_org_header():
    from app.routers.integrations import _clean_org_headers

    with pytest.raises(HTTPException) as exc:
        _clean_org_headers({"x-synesis-org-id": "org-1\nrole=admin"})

    assert exc.value.status_code == 422


def test_admin_mcp_audit_argument_redaction():
    from app.services.admin_mcp_ts_client import _redact_tool_arguments

    redacted = _redact_tool_arguments(
        {
            "session_key": "secret-session",
            "url": "https://example.com",
            "nested": {"authorization": "Bearer secret", "safe": "value"},
        }
    )

    assert redacted["session_key"] == "<redacted>"
    assert redacted["url"] == "https://example.com"
    assert redacted["nested"]["authorization"] == "<redacted>"
    assert redacted["nested"]["safe"] == "value"


def test_content_pack_config_uses_default_catalog_when_unconfigured():
    from app.routers.rag import _content_pack_config_dict

    config = _content_pack_config_dict(None)

    assert config["catalog_url"] == "https://r2.kybern.dev/synesis-pack-catalog.json"
    assert config["default_catalog_url"] == "https://r2.kybern.dev/synesis-pack-catalog.json"
    assert config["configured_catalog_url"] == ""
    assert config["using_default"] is True


def test_content_pack_config_normalizes_legacy_r2_catalog_url():
    from types import SimpleNamespace

    from app.routers.rag import _content_pack_config_dict

    row = SimpleNamespace(
        catalog_url="https://r2.kybern.dev/synpacks/synesis-pack-catalog.json",
        updated_by="operator",
        updated_at=None,
    )
    config = _content_pack_config_dict(row)

    assert config["catalog_url"] == "https://r2.kybern.dev/synesis-pack-catalog.json"
    assert config["configured_catalog_url"] == "https://r2.kybern.dev/synpacks/synesis-pack-catalog.json"
    assert config["using_default"] is True


def test_security_events_rejects_invented_filter_values(monkeypatch):
    from app.auth import UserInfo, get_current_user
    from app.main import app
    from fastapi.testclient import TestClient

    async def _override_user() -> UserInfo:
        return UserInfo(
            username="org-admin",
            role="org_admin",
            user_id="u-1",
            org_id="org-1",
            org_name="Org 1",
        )

    async def _list_events_should_not_run(**_kwargs):
        raise AssertionError("security event list should not run for invalid filters")

    monkeypatch.setattr("app.routers.security.security_service.list_events", _list_events_should_not_run)
    app.dependency_overrides[get_current_user] = _override_user
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/api/v1/security/events",
                params={
                    "severity": "critical",
                    "event_type": "system_prompt_exfiltration",
                    "service": "admin",
                },
            )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp.status_code == 422


def test_security_events_accepts_only_known_filter_values(monkeypatch):
    from app.auth import UserInfo, get_current_user
    from app.main import app
    from fastapi.testclient import TestClient

    captured: dict[str, object] = {}

    async def _override_user() -> UserInfo:
        return UserInfo(
            username="org-admin",
            role="org_admin",
            user_id="u-1",
            org_id="org-1",
            org_name="Org 1",
        )

    async def _list_events(**kwargs):
        captured.update(kwargs)
        return []

    monkeypatch.setattr("app.routers.security.security_service.list_events", _list_events)
    app.dependency_overrides[get_current_user] = _override_user
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/api/v1/security/events",
                params={
                    "severity": "high",
                    "event_type": "system_override_attempt",
                    "service": "yarn",
                    "resolved": "false",
                    "since_hours": "24",
                    "limit": "50",
                },
            )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp.status_code == 200
    assert resp.json() == {"events": []}
    assert captured["severity"] == "high"
    assert captured["event_type"] == "system_override_attempt"
    assert captured["service"] == "yarn"
    assert captured["scope_org_id"] == "org-1"


def test_security_events_rejects_org_admin_without_org_id(monkeypatch):
    from app.auth import UserInfo, get_current_user
    from app.main import app
    from fastapi.testclient import TestClient

    async def _override_user() -> UserInfo:
        return UserInfo(
            username="org-admin",
            role="org_admin",
            user_id="u-1",
            org_id="",
            org_name="",
        )

    async def _list_events_should_not_run(**_kwargs):
        raise AssertionError("security event list must not run without org scope")

    monkeypatch.setattr("app.routers.security.security_service.list_events", _list_events_should_not_run)
    app.dependency_overrides[get_current_user] = _override_user
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            resp = client.get("/api/v1/security/events")
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp.status_code == 403


def test_security_events_rejects_malformed_org_admin_org_id(monkeypatch):
    from app.auth import UserInfo, get_current_user
    from app.main import app
    from fastapi.testclient import TestClient

    async def _override_user() -> UserInfo:
        return UserInfo(
            username="org-admin",
            role="org_admin",
            user_id="u-1",
            org_id="org-1\nrole=platform_admin",
            org_name="",
        )

    async def _list_events_should_not_run(**_kwargs):
        raise AssertionError("security event list must not run with invalid org scope")

    monkeypatch.setattr("app.routers.security.security_service.list_events", _list_events_should_not_run)
    app.dependency_overrides[get_current_user] = _override_user
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            resp = client.get("/api/v1/security/events")
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp.status_code == 403


def test_security_ingest_rejects_unknown_security_payload_fields(monkeypatch):
    from app.main import app
    from fastapi.testclient import TestClient

    monkeypatch.setenv("SYNESIS_INTERNAL_SERVICE_TOKEN", "svc-secret")

    async def _ingest_should_not_run(_body):
        raise AssertionError("security ingest should not run for invalid payloads")

    monkeypatch.setattr("app.routers.security.security_service.ingest_event", _ingest_should_not_run)
    payload = {
        "event_id": "yarn-r1-1",
        "event_type": "system_override_attempt",
        "severity": "high",
        "confidence": 0.95,
        "confidence_band": "high",
        "action_taken": "block",
        "scope": "request",
        "service": "yarn",
        "request_id": "r1",
        "session_id": "",
        "user_id": "",
        "token_id": "",
        "org_id": "org-1",
        "patterns_found": ["ignore previous instructions"],
        "excerpt": "ignore previous instructions",
        "scanner_name": "synesis_guardrails_ts",
        "latency_ms": 2.5,
        "detail": {"tier": "core", "source": "user_message", "invented_security_attr": True},
        "role": "platform_admin",
    }

    with TestClient(app, raise_server_exceptions=False) as client:
        resp = client.post(
            "/api/v1/security/events/ingest",
            headers={"x-synesis-service-token": "svc-secret", "x-synesis-service-name": "yarn"},
            json=payload,
        )

    assert resp.status_code == 422


def test_security_ingest_accepts_current_context_trust_payload(monkeypatch):
    from app.main import app
    from fastapi.testclient import TestClient

    monkeypatch.setenv("SYNESIS_INTERNAL_SERVICE_TOKEN", "svc-secret")
    captured: dict[str, object] = {}

    async def _ingest(body):
        captured.update(body)
        return body["event_id"]

    monkeypatch.setattr("app.routers.security.security_service.ingest_event", _ingest)
    payload = {
        "event_id": "planner-r1-1",
        "event_type": "prompt_leakage_attempt",
        "severity": "medium",
        "confidence": 0.8,
        "confidence_band": "high",
        "action_taken": "log",
        "scope": "request",
        "service": "planner",
        "request_id": "r1",
        "session_id": "s1",
        "user_id": "u1",
        "token_id": "",
        "org_id": "org-1",
        "patterns_found": ["show your system prompt"],
        "excerpt": "show your system prompt",
        "scanner_name": "synesis_guardrails_ts",
        "latency_ms": 3.0,
        "detail": {"tier": "web", "source": "web", "patterns_count": 1},
    }

    with TestClient(app, raise_server_exceptions=False) as client:
        resp = client.post(
            "/api/v1/security/events/ingest",
            headers={"x-synesis-service-token": "svc-secret", "x-synesis-service-name": "planner"},
            json=payload,
        )

    assert resp.status_code == 200
    assert resp.json() == {"event_id": "planner-r1-1", "status": "ingested"}
    assert captured["event_type"] == "prompt_leakage_attempt"
    assert captured["service"] == "planner"
    assert captured["detail"] == {"tier": "web", "source": "web", "patterns_count": 1}
