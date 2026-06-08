#!/usr/bin/env python3
"""Ensure duplicated JSON Schema ingress contracts stay in sync."""

from __future__ import annotations

import difflib
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PAIRS = [
    (
        REPO_ROOT / "base/planner-ts/src/json-schema-contract.ts",
        REPO_ROOT / "base/yarn-ts/src/json-schema-contract.ts",
    ),
]


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

    print("JSON Schema contract parity check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
