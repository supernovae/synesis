"""Revision constraints per strategy. Relax when switching strategy.

Deterministic strategy selection (failure_type → strategy):
  lint          → minimal_fix (LSP never; format/style)
  security      → minimal_fix OR revert_and_patch (depends on finding)
  lsp           → lsp_symbol_first (type/symbol/compile; LSP eligible)
  runtime       → refactor vs revert_and_patch (stack trace category)
  spec_mismatch → spec_alignment_first
  integrity_gate → integrity_fix (no strategy_candidates; no append to tried)
"""

from typing import Any

REVISION_CONSTRAINTS: dict[str, dict[str, Any]] = {
    "minimal_fix": {
        "max_files_touched": 1,
        "max_loc_delta": 30,
        "forbidden": ["extract_module", "rename_symbol"],
        "preserve_stages": ["lint", "security"],
        "preserve_stages_anchor": "hard",
    },
    "refactor": {
        "max_files_touched": 5,
        "max_loc_delta": 200,
        "forbidden": [],
        "preserve_stages": [],
        "preserve_stages_anchor": "soft",
    },
    "revert_and_patch": {
        "max_files_touched": 1,
        "max_loc_delta": 50,
        "forbidden": [],
        "preserve_stages": ["lint"],
        "preserve_stages_anchor": "hard",
    },
    "lsp_symbol_first": {
        "max_files_touched": 2,
        "max_loc_delta": 40,
        "forbidden": [],
        "preserve_stages": ["lint"],
        "preserve_stages_anchor": "hard",
    },
    "spec_alignment_first": {
        "max_files_touched": 2,
        "max_loc_delta": 60,
        "forbidden": [],
        "preserve_stages": ["lint", "security"],
        "preserve_stages_anchor": "hard",
    },
    "security_fix": {
        "max_files_touched": 1,
        "max_loc_delta": 25,
        "forbidden": ["refactor", "extract_module"],
        "preserve_stages": ["lint"],
        "preserve_stages_anchor": "hard",
    },
}

STRATEGY_CANDIDATES_BY_FAILURE: dict[str, list[dict[str, str | float]]] = {
    "lint": [
        {"name": "minimal_fix", "weight": 0.8, "why": "lint"},
        {"name": "refactor", "weight": 0.2, "why": "fallback"},
    ],
    "security": [
        {"name": "security_fix", "weight": 0.7, "why": "security"},
        {"name": "minimal_fix", "weight": 0.2, "why": "security"},
        {"name": "revert_and_patch", "weight": 0.1, "why": "security"},
    ],
    "lsp": [
        {"name": "lsp_symbol_first", "weight": 0.8, "why": "lsp"},
        {"name": "minimal_fix", "weight": 0.2, "why": "fallback"},
    ],
    "runtime": [
        {"name": "refactor", "weight": 0.5, "why": "runtime"},
        {"name": "revert_and_patch", "weight": 0.5, "why": "runtime"},
    ],
    "spec_mismatch": [{"name": "spec_alignment_first", "weight": 0.9, "why": "spec"}],
    "default": [
        {"name": "minimal_fix", "weight": 0.6, "why": "default"},
        {"name": "refactor", "weight": 0.4, "why": "fallback"},
    ],
}
