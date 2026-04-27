from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "base" / "webui" / "overrides"))

from capability_matrix import CapabilityMatrixInput, resolve_capability_matrix


@pytest.mark.parametrize(
    "fixture_case",
    json.loads((REPO_ROOT / "docs" / "coder" / "capability-matrix-resolver-fixtures.json").read_text(encoding="utf-8"))[
        "cases"
    ],
)
def test_capability_matrix_resolver_contract(fixture_case: dict) -> None:
    matrix_input = CapabilityMatrixInput(
        model_id=fixture_case["input"]["model_id"],
        model_path=fixture_case["input"].get("model_path", ""),
        family=fixture_case["input"].get("family", ""),
    )
    actual = resolve_capability_matrix(fixture_case["matrix"], matrix_input)
    expected = fixture_case["expected"]

    assert actual["mode"] == expected["mode"]
    assert actual["global_optimizations_enabled"] == expected["global_optimizations_enabled"]
    assert actual["resolved_capabilities"] == expected["resolved_capabilities"]
    assert actual["matched_override_ids"] == expected["matched_override_ids"]
