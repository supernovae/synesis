"""Regression matrix for Synesis Coder client fingerprints.

Expand this file when you capture real User-Agent / x-client / x-app values from
Cursor, Claude Code, Roo Code, Kilo Code, Cline, OpenCode, Crush, Goose, etc.
Each row documents expected ``CoderClientKind`` for representative headers.
"""

from __future__ import annotations

import pytest

pytest.importorskip("starlette")

from app.client_identity import CoderClientKind, classify_coder_client_headers

# (label, headers, expected) — add rows as you observe production traffic.
VENDOR_MATRIX: list[tuple[str, dict[str, str], CoderClientKind]] = [
    ("cursor_generic", {"user-agent": "Cursor/0.49.0"}, CoderClientKind.CURSOR),
    ("claude_code_x_client", {"x-client": "claude-code"}, CoderClientKind.CLAUDE_CODE),
    ("vscode_rest", {"user-agent": "vscode-restclient"}, CoderClientKind.VSCODE),
    ("roo_code_app", {"x-app": "Roo-Code"}, CoderClientKind.ROO_CODE),
    ("kilo_code_ua", {"user-agent": "KiloCode/2.0"}, CoderClientKind.KILO_CODE),
    ("cline_ua", {"user-agent": "Cline/3.4.0"}, CoderClientKind.CLINE),
    ("opencode_cli", {"user-agent": "opencode/0.1.0"}, CoderClientKind.OPENCODE),
    ("windsurf", {"user-agent": "Windsurf/1.2"}, CoderClientKind.WINDSURF),
    ("crush_marker", {"x-app": "crush-ide"}, CoderClientKind.CRUSH),
    ("goose_block", {"user-agent": "block/goose 1.0"}, CoderClientKind.GOOSE),
    ("unknown_browser", {"user-agent": "Mozilla/5.0"}, CoderClientKind.UNKNOWN),
]


@pytest.mark.parametrize(
    "label,headers,expected",
    VENDOR_MATRIX,
    ids=[row[0] for row in VENDOR_MATRIX],
)
def test_vendor_classification_matrix(
    label: str,
    headers: dict[str, str],
    expected: CoderClientKind,
):
    assert classify_coder_client_headers(headers) == expected, label
