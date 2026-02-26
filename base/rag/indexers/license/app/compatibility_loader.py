"""Load the built-in license compatibility matrix."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import yaml

logger = logging.getLogger("synesis.indexer.license.compatibility")


@dataclass
class CompatibilityRule:
    from_license: str
    to_license: str
    compatible: str  # "true", "false", "conditional"
    note: str


def load_compatibility_rules(path: str | Path) -> list[CompatibilityRule]:
    """Load compatibility rules from the YAML matrix."""
    path = Path(path)
    if not path.exists():
        logger.warning(f"Compatibility file not found: {path}")
        return []

    with open(path) as f:
        data = yaml.safe_load(f)

    rules: list[CompatibilityRule] = []
    for entry in data.get("rules", []):
        rules.append(CompatibilityRule(
            from_license=entry["from"],
            to_license=entry["to"],
            compatible=str(entry.get("compatible", "unknown")),
            note=entry.get("note", ""),
        ))

    logger.info(f"Loaded {len(rules)} compatibility rules")
    return rules


def load_copyleft_classification(path: str | Path) -> dict[str, str]:
    """Load the copyleft classification mapping (spdx_id -> none/weak/strong)."""
    path = Path(path)
    if not path.exists():
        return {}

    with open(path) as f:
        data = yaml.safe_load(f)

    classification: dict[str, str] = {}
    for level, ids in data.get("copyleft_classification", {}).items():
        for spdx_id in ids:
            classification[spdx_id] = level

    return classification
