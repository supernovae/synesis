"""Classify IDE / agent clients for Synesis Coder (Yarn) observability and policy.

Signature needles are kept aligned with planner-ts client-identification behavior.
Extend both files together when adding a new client fingerprint.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import Enum
from typing import Any

from starlette.requests import Request


class CoderClientKind(str, Enum):
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
    blob = _header_blob(headers)
    for needle, kind in _CODER_CLIENT_SIGNATURES:
        if needle in blob:
            return kind
    return CoderClientKind.UNKNOWN


def classify_coder_client_request(request: Request) -> CoderClientKind:
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


def client_identity_log_extra(request: Request) -> dict[str, Any]:
    """Structured fields for request logs (extend as behaviors are added)."""
    kind = classify_coder_client_request(request)
    return {
        "coder_client_kind": kind.value,
        "coder_client_hint": kind != CoderClientKind.UNKNOWN,
    }
