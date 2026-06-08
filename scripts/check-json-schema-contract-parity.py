#!/usr/bin/env python3
"""Ensure duplicated JSON Schema ingress contracts stay in sync."""

from __future__ import annotations

import difflib
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PAIRS = [
    (
        REPO_ROOT / "base/planner-ts/src/json-schema-contract.ts",
        REPO_ROOT / "base/yarn-ts/src/json-schema-contract.ts",
    ),
]
MCP_CATALOG_SCHEMA_KEY_PAIRS = [
    (
        REPO_ROOT / "packages/synesis-mcp-tools/src/catalog.ts",
        REPO_ROOT / "base/yarn-ts/src/mcp/tool-registry.ts",
    ),
]


def extract_string_set(source: str, const_name: str) -> set[str]:
    match = re.search(rf"const {re.escape(const_name)} = new Set\(\[(.*?)\]\);", source, re.DOTALL)
    if not match:
        raise ValueError(f"missing set declaration: {const_name}")
    return set(re.findall(r'"([^"]+)"', match.group(1)))


def main() -> int:
    for left, right in CONTRACT_PAIRS:
        left_text = left.read_text(encoding="utf-8")
        right_text = right.read_text(encoding="utf-8")
        if left_text == right_text:
            continue

        rel_left = left.relative_to(REPO_ROOT)
        rel_right = right.relative_to(REPO_ROOT)
        print(f"JSON Schema contract drift detected: {rel_left} != {rel_right}", file=sys.stderr)
        diff = difflib.unified_diff(
            left_text.splitlines(keepends=True),
            right_text.splitlines(keepends=True),
            fromfile=str(rel_left),
            tofile=str(rel_right),
        )
        sys.stderr.writelines(diff)
        return 1

    for left, right in MCP_CATALOG_SCHEMA_KEY_PAIRS:
        left_text = left.read_text(encoding="utf-8")
        right_text = right.read_text(encoding="utf-8")
        try:
            left_keys = extract_string_set(left_text, "CATALOG_JSON_SCHEMA_KEYS")
            right_keys = extract_string_set(right_text, "CATALOG_JSON_SCHEMA_KEYS")
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        if left_keys == right_keys:
            continue

        rel_left = left.relative_to(REPO_ROOT)
        rel_right = right.relative_to(REPO_ROOT)
        print(f"MCP catalog schema key drift detected: {rel_left} != {rel_right}", file=sys.stderr)
        only_left = sorted(left_keys - right_keys)
        only_right = sorted(right_keys - left_keys)
        if only_left:
            print(f"Only in {rel_left}: {only_left}", file=sys.stderr)
        if only_right:
            print(f"Only in {rel_right}: {only_right}", file=sys.stderr)
        return 1

    print("JSON Schema contract parity check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
