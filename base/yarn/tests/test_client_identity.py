"""Unit tests for Synesis Coder client fingerprinting."""

from __future__ import annotations

import pytest

pytest.importorskip("starlette")

from app.client_identity import CoderClientKind, classify_coder_client_headers
from starlette.requests import Request


def _req(ua: str = "") -> Request:
    hdrs = [(b"user-agent", ua.encode())] if ua else []
    return Request({"type": "http", "headers": hdrs})


@pytest.mark.parametrize(
    ("headers", "expected"),
    [
        ({"user-agent": "cursor-agent/1.0"}, CoderClientKind.CURSOR),
        ({"x-client": "claude-code"}, CoderClientKind.CLAUDE_CODE),
        ({"user-agent": "OpenCode/0.1"}, CoderClientKind.OPENCODE),
        ({"x-app": "Kilo-Code"}, CoderClientKind.KILO_CODE),
        ({}, CoderClientKind.UNKNOWN),
    ],
)
def test_classify_headers(headers: dict[str, str], expected: CoderClientKind):
    assert classify_coder_client_headers(headers) == expected


def test_client_identity_log_extra_contains_kind():
    from app.client_identity import client_identity_log_extra

    r = _req("Cursor")
    extra = client_identity_log_extra(r)
    assert extra["coder_client_kind"] == "cursor"
    assert extra["coder_client_hint"] is True


def test_signature_count_matches_planner_contract():
    from app import client_identity as m

    assert len(m._CODER_CLIENT_SIGNATURES) == 19
