#!/usr/bin/env python3
"""
Validate high-signal doc/rule references for runtime consistency.

This check is intentionally lightweight and focused on files that define
behavior contracts used by maintainers and coding agents.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

TARGET_FILES = [
    ".cursor/rules/router-governed-evidence.mdc",
    ".cursor/rules/synesis-regressions.mdc",
    ".cursor/rules/sse-status-format.mdc",
    "docs/chat/OPENWEBUI_PHASES.md",
]

FORBIDDEN_TOKENS: dict[str, list[str]] = {
    ".cursor/rules/router-governed-evidence.mdc": [
        "test_router_governance.py",
    ],
    ".cursor/rules/synesis-regressions.mdc": [
        "test_router_governance.py",
    ],
    ".cursor/rules/sse-status-format.mdc": [
        "_sse_status_chunk",
        "_emit_phase(",
        "streaming_events.py",
    ],
}

REQUIRED_TOKENS: dict[str, list[str]] = {
    ".cursor/rules/router-governed-evidence.mdc": [
        "base/planner-ts/tests/router-governance.test.ts",
    ],
    ".cursor/rules/sse-status-format.mdc": [
        "base/planner-ts/src/streaming/sse.ts",
        "base/planner-ts/tests/sse-status-shape.test.ts",
    ],
}

PATH_TOKEN_RE = re.compile(r"([A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]+)")


def collect_path_tokens(text: str) -> set[str]:
    tokens: set[str] = set()
    for match in PATH_TOKEN_RE.finditer(text):
        token = match.group(1).strip()
        start = match.start(1)
        prefix = text[max(0, start - 8) : start].lower()
        if prefix.endswith("http://") or prefix.endswith("https://"):
            continue
        if not token or "*" in token:
            continue
        if token.startswith(("http://", "https://")):
            continue
        tokens.add(token)
    return tokens


def main() -> int:
    errors: list[str] = []

    for rel in TARGET_FILES:
        file_path = REPO_ROOT / rel
        if not file_path.exists():
            errors.append(f"missing target file: {rel}")
            continue

        content = file_path.read_text(encoding="utf-8")

        for forbidden in FORBIDDEN_TOKENS.get(rel, []):
            if forbidden in content:
                errors.append(f"{rel}: forbidden reference '{forbidden}' found")

        for required in REQUIRED_TOKENS.get(rel, []):
            if required not in content:
                errors.append(f"{rel}: required reference '{required}' missing")

        for ref in collect_path_tokens(content):
            if ref.startswith(("../", "./")):
                ref_path = (file_path.parent / ref).resolve()
            else:
                ref_path = (REPO_ROOT / ref).resolve()
            if not ref_path.exists():
                errors.append(f"{rel}: referenced path does not exist: {ref}")

    if errors:
        print("Doc/rule reference integrity check failed:")
        for err in errors:
            print(f"- {err}")
        return 1

    print("Doc/rule reference integrity check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
