"""Detect IDE / agent clients (Cursor, Claude Code, etc.) from HTTP headers.

Used by the planner for coding-bias hints on ambiguous requests. Signature
needles are kept aligned with ``base/yarn/app/client_identity.py`` so both
services classify clients consistently for Synesis Coder / pipeline behavior.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import Enum

from starlette.requests import Request


class CoderClientKind(str, Enum):
    """Known coding clients connecting to Synesis (planner or Yarn)."""

    UNKNOWN = "unknown"
    CURSOR = "cursor"
    CLAUDE_CODE = "claude_code"
    VSCODE = "vscode"
    WINDSURF = "windsurf"
    CODEIUM = "codeium"
    ROO_CODE = "roo_code"
    KILO_CODE = "kilo_code"
    CLINE = "cline"
    OPENCODE = "opencode"
    CRUSH = "crush"
    GOOSE = "goose"


# (substring, kind) — order matters: more specific needles first.
_CODER_CLIENT_SIGNATURES: tuple[tuple[str, CoderClientKind], ...] = (
    ("claude-code", CoderClientKind.CLAUDE_CODE),
    ("claude code", CoderClientKind.CLAUDE_CODE),
    ("cursor", CoderClientKind.CURSOR),
    ("windsurf", CoderClientKind.WINDSURF),
    ("codeium", CoderClientKind.CODEIUM),
    ("roocode", CoderClientKind.ROO_CODE),
    ("roo-code", CoderClientKind.ROO_CODE),
    ("kilo-code", CoderClientKind.KILO_CODE),
    ("kilocode", CoderClientKind.KILO_CODE),
    ("kilo code", CoderClientKind.KILO_CODE),
    ("cline", CoderClientKind.CLINE),
    ("opencode", CoderClientKind.OPENCODE),
    ("vscode", CoderClientKind.VSCODE),
    ("visual studio code", CoderClientKind.VSCODE),
    # Narrower hooks — avoid bare "crush"/"goose" in UA alone
    ("x-crush-client", CoderClientKind.CRUSH),
    ("crush-ide", CoderClientKind.CRUSH),
    ("block/goose", CoderClientKind.GOOSE),
    ("block-goose", CoderClientKind.GOOSE),
    ("goose-ai", CoderClientKind.GOOSE),
)


def _header_blob(headers: Mapping[str, str]) -> str:
    parts = [
        headers.get("user-agent") or "",
        headers.get("x-client") or "",
        headers.get("x-app") or "",
        headers.get("x-openai-client") or "",
        headers.get("x-stainless-lang") or "",
    ]
    return " ".join(p.lower() for p in parts)


def classify_coder_client_headers(headers: Mapping[str, str]) -> CoderClientKind:
    """Return the best-matching client kind from normalized request headers."""
    blob = _header_blob(headers)
    for needle, kind in _CODER_CLIENT_SIGNATURES:
        if needle in blob:
            return kind
    return CoderClientKind.UNKNOWN


def classify_coder_client_request(request: Request) -> CoderClientKind:
    """Classify from a Starlette/FastAPI request (headers are lower-cased)."""
    h = request.headers
    return classify_coder_client_headers(
        {
            "user-agent": h.get("user-agent", ""),
            "x-client": h.get("x-client", ""),
            "x-app": h.get("x-app", ""),
            "x-openai-client": h.get("x-openai-client", ""),
            "x-stainless-lang": h.get("x-stainless-lang", ""),
        }
    )


def is_coding_client_request(request: Request) -> bool:
    """True if the request looks like a coding IDE/agent (planner hot path)."""
    return classify_coder_client_request(request) != CoderClientKind.UNKNOWN
