"""Taxonomy config linter — validate taxonomy_prompt_config.yaml at startup.

Guards against regressions: missing required fields, invalid types, complexity
out of range, duplicate paths, orphan domains (referenced in routing but missing
from taxonomy). Run via lint_taxonomy_config() during lifespan or in tests.
"""

from __future__ import annotations

import logging
from collections import Counter
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError, field_validator

from .plugin_weight_loader import load_config_with_plugins

logger = logging.getLogger("synesis.taxonomy_linter")


class TaxonomyEntry(BaseModel):
    """Pydantic model for a single taxonomy entry in taxonomy_prompt_config.yaml."""

    path: str
    complexity: float
    persona: str = "Helpful Assistant"
    worker_explain_tone: str = ""
    depth_instructions: str = ""
    discovery_prompt: str = ""
    required_elements: list[str] | None = None
    output_style: str = ""
    output_style_guidance: str = ""
    epistemic_guidance: str = ""
    planner_decomposition_rules: str = ""
    query_expansion_hints: list[str] | None = None
    preferred_web_scopes: list[str] | None = None

    @field_validator("complexity")
    @classmethod
    def complexity_in_range(cls, v: float) -> float:
        if not (0.0 <= v <= 1.0):
            raise ValueError(f"complexity must be 0.0-1.0, got {v}")
        return v

    model_config = {"extra": "allow"}


def _collect_routed_domains(
    core_path: Path | None = None,
    plugin_dir: Path | str | None = None,
) -> set[str]:
    """Collect all domain: values referenced in routing/classifier YAML."""
    try:
        cfg = load_config_with_plugins(core_path=core_path, plugin_dir=plugin_dir)
    except Exception:
        return set()

    domains: set[str] = set()
    dk = cfg.get("domain_keywords") or {}
    for cat_data in dk.values():
        if isinstance(cat_data, dict):
            d = cat_data.get("domain")
            if isinstance(d, str) and d:
                domains.add(d.strip().lower())

    ow = cfg.get("overrides") or {}
    for entries in ow.values():
        if isinstance(entries, list):
            for item in entries:
                if isinstance(item, str):
                    parts = item.split(":")
                    if len(parts) >= 2 and parts[0].strip() == "domain":
                        domains.add(parts[1].strip().lower())

    return domains


def lint_taxonomy_config(
    taxonomy_cfg: dict[str, Any] | None = None,
) -> list[str]:
    """Validate taxonomy config. Returns list of error/warning strings (empty = OK).

    If taxonomy_cfg is None, loads from the standard config path.
    """
    issues: list[str] = []

    if taxonomy_cfg is None:
        from .taxonomy_prompt_factory import _load_config

        taxonomy_cfg = _load_config()

    taxonomies = {
        k: v
        for k, v in (taxonomy_cfg or {}).items()
        if isinstance(v, dict) and "path" in v
    }

    if not taxonomies:
        issues.append("No taxonomy entries found (expected dict entries with 'path' key)")
        return issues

    # 1. Per-entry validation via Pydantic
    for key, entry in taxonomies.items():
        try:
            TaxonomyEntry.model_validate(entry)
        except ValidationError as e:
            for err in e.errors():
                loc = ".".join(str(x) for x in err["loc"])
                issues.append(f"{key}.{loc}: {err['msg']}")

    # 2. Duplicate path detection
    path_counts = Counter(
        str(v.get("path", "")).strip()
        for v in taxonomies.values()
        if isinstance(v.get("path"), str)
    )
    for path_val, count in path_counts.items():
        if count > 1:
            dupes = [k for k, v in taxonomies.items() if str(v.get("path", "")).strip() == path_val]
            issues.append(f"duplicate path '{path_val}' in entries: {', '.join(dupes)}")

    # 3. Orphan domain detection
    routed = _collect_routed_domains()
    taxonomy_keys = set(taxonomies.keys())
    orphans = routed - taxonomy_keys
    if orphans:
        for orphan in sorted(orphans):
            issues.append(f"orphan domain '{orphan}': referenced in routing YAML but missing from taxonomy")

    # 4. Alias collision detection (query_expansion_hints)
    hint_owners: dict[str, list[str]] = {}
    for key, entry in taxonomies.items():
        hints = entry.get("query_expansion_hints")
        if isinstance(hints, list):
            for hint in hints:
                h = str(hint).strip().lower()
                if h:
                    hint_owners.setdefault(h, []).append(key)
    for hint, owners in hint_owners.items():
        if len(owners) > 1:
            issues.append(f"alias collision: hint '{hint}' shared by {', '.join(owners)}")

    if issues:
        logger.warning("taxonomy_config_lint issues=%d first=%s", len(issues), issues[0])

    return issues
