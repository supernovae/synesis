from __future__ import annotations

from dataclasses import dataclass
from typing import Any

KNOWN_CAPABILITY_KEYS = (
    "yarn.reducers_enabled",
    "yarn.transcript_prune_enabled",
    "yarn.phase_execution_policy_enabled",
    "yarn.json_compaction_enabled",
    "yarn.content_dedupe_enabled",
    "yarn.response_dedupe_enabled",
    "yarn.historical_normalize_enabled",
    "planner.context_optimizer_enabled",
    "webui.builtin_tools_enabled",
    "webui.file_context_enabled",
)


@dataclass(frozen=True)
class CapabilityMatrixInput:
    model_id: str
    model_path: str = ""
    family: str = ""


def _norm(value: str | None) -> str:
    return str(value or "").strip().lower()


def _selector_rank(selector_type: str) -> int:
    if selector_type == "family_prefix":
        return 1
    if selector_type == "model_path_prefix":
        return 2
    return 3


def _matches_selector(row: dict[str, Any], matrix_input: CapabilityMatrixInput) -> bool:
    selector_type = row.get("selector_type", "")
    selector = _norm(row.get("selector", ""))
    if not selector:
        return False
    if selector_type == "exact_model":
        return _norm(matrix_input.model_id) == selector
    if selector_type == "model_path_prefix":
        model_path = _norm(matrix_input.model_path)
        return bool(model_path) and model_path.startswith(selector)
    if selector_type == "family_prefix":
        family = _norm(matrix_input.family)
        return bool(family) and family.startswith(selector)
    return False


def resolve_capability_matrix(
    matrix_document: dict[str, Any] | None,
    matrix_input: CapabilityMatrixInput,
) -> dict[str, Any]:
    matrix = matrix_document or {}
    mode = "shadow" if matrix.get("mode") == "shadow" else "enforced"
    global_enabled = matrix.get("global_optimizations_enabled") is True

    resolved = {key: global_enabled for key in KNOWN_CAPABILITY_KEYS}

    overrides = matrix.get("overrides", [])
    if not isinstance(overrides, list):
        overrides = []

    normalized_rows: list[dict[str, Any]] = []
    for row in overrides:
        if not isinstance(row, dict):
            continue
        selector_type = row.get("selector_type")
        if selector_type not in ("exact_model", "model_path_prefix", "family_prefix"):
            continue
        if row.get("enabled", True) is False:
            continue
        if not isinstance(row.get("id"), str):
            continue
        capabilities = row.get("capabilities")
        if not isinstance(capabilities, dict):
            continue
        normalized_rows.append(row)

    matches = [row for row in normalized_rows if _matches_selector(row, matrix_input)]
    matches.sort(
        key=lambda row: (
            _selector_rank(str(row.get("selector_type", ""))),
            int(row.get("priority", 0)),
            str(row.get("id", "")),
        )
    )

    for row in matches:
        capabilities = row.get("capabilities", {})
        for raw_key, raw_value in capabilities.items():
            if raw_key not in KNOWN_CAPABILITY_KEYS:
                continue
            if isinstance(raw_value, bool):
                resolved[raw_key] = raw_value

    return {
        "mode": mode,
        "global_optimizations_enabled": global_enabled,
        "resolved_capabilities": resolved,
        "matched_override_ids": [str(row.get("id", "")) for row in matches],
        "matched_selectors": [
            {
                "id": str(row.get("id", "")),
                "selector_type": str(row.get("selector_type", "")),
                "selector": str(row.get("selector", "")),
                "priority": int(row.get("priority", 0)),
            }
            for row in matches
        ],
    }
