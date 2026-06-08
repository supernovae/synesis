"""Focused regressions for admin security hardening helpers."""

from __future__ import annotations

import pytest
from fastapi import HTTPException, Request


def _request(headers: list[tuple[bytes, bytes]] | None = None) -> Request:
    return Request({"type": "http", "method": "POST", "headers": headers or []})


def test_internal_service_token_fails_closed_when_unconfigured(monkeypatch):
    from app.internal_auth import require_internal_service_token_request

    monkeypatch.delenv("SYNESIS_INTERNAL_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("SYNESIS_INTERNAL_SERVICE_TOKENS", raising=False)

    with pytest.raises(HTTPException) as exc:
        require_internal_service_token_request(_request())

    assert exc.value.status_code == 503


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
