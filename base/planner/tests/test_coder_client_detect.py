"""Unit tests for IDE/agent client classification (Synesis pipeline hints)."""

from __future__ import annotations

import pytest

pytest.importorskip("starlette")

from app.coder_client_detect import CoderClientKind, classify_coder_client_headers, classify_coder_client_request
from starlette.requests import Request


def _req(ua: str = "", x_client: str = "", x_app: str = "") -> Request:
    hdrs: list[tuple[bytes, bytes]] = []
    if ua:
        hdrs.append((b"user-agent", ua.encode()))
    if x_client:
        hdrs.append((b"x-client", x_client.encode()))
    if x_app:
        hdrs.append((b"x-app", x_app.encode()))
    return Request({"type": "http", "headers": hdrs})


@pytest.mark.parametrize(
    ("headers", "expected"),
    [
        ({"user-agent": "Cursor/0.42"}, CoderClientKind.CURSOR),
        ({"user-agent": "vscode-rest-client"}, CoderClientKind.VSCODE),
        ({"x-client": "claude-code"}, CoderClientKind.CLAUDE_CODE),
        ({"x-app": "Roo-Code"}, CoderClientKind.ROO_CODE),
        ({"user-agent": "KiloCode/1.0"}, CoderClientKind.KILO_CODE),
        ({"user-agent": "Cline/3.0"}, CoderClientKind.CLINE),
        ({"user-agent": "opencode-cli"}, CoderClientKind.OPENCODE),
        ({"user-agent": "Windsurf/1.0"}, CoderClientKind.WINDSURF),
        ({"user-agent": "Codeium"}, CoderClientKind.CODEIUM),
        ({"x-app": "crush-ide"}, CoderClientKind.CRUSH),
        ({"user-agent": "block/goose-agent"}, CoderClientKind.GOOSE),
        ({}, CoderClientKind.UNKNOWN),
    ],
)
def test_classify_headers(headers: dict[str, str], expected: CoderClientKind):
    assert classify_coder_client_headers(headers) == expected


def test_classify_request_uses_starlette_headers():
    r = _req("Mozilla/5.0 (compatible; Cursor/1.0)")
    assert classify_coder_client_request(r) == CoderClientKind.CURSOR


def test_signature_count_matches_yarn_module_docstring_contract():
    """Bump this when adding needles; keep yarn/app/client_identity.py in sync."""
    from app import coder_client_detect as m

    assert len(m._CODER_CLIENT_SIGNATURES) == 19
