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
