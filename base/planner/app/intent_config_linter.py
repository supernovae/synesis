"""IntentEnvelope config linter — validate entry_classifier YAML at startup.

Guards against regressions: missing thresholds, invalid weight structures,
empty keyword lists. Supports v3 split: complexity_weights, risk_weights, domain_keywords.
Run via lint_intent_config() during lifespan or in tests.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .plugin_weight_loader import load_config_with_plugins

logger = logging.getLogger("synesis.entry_classifier")


def _lint_weights(weights: dict[str, Any], prefix: str) -> list[str]:
    """Lint a weights dict. Returns list of issues."""
    issues: list[str] = []
    if not isinstance(weights, dict):
        return [f"{prefix} must be a dict"]
    for cat, data in weights.items():
        if not isinstance(data, dict):
            issues.append(f"{prefix}.{cat}: must be dict with keywords")
            continue
        kw = data.get("keywords")
        if kw is None:
            issues.append(f"{prefix}.{cat}: missing 'keywords'")
        elif not isinstance(kw, list):
            issues.append(f"{prefix}.{cat}: keywords must be list")
        elif len(kw) == 0:
            issues.append(f"{prefix}.{cat}: keywords must not be empty")
        if prefix in ("complexity_weights", "risk_weights") and "weight" in data:
            w = data["weight"]
            if not isinstance(w, (int, float)):
                issues.append(f"{prefix}.{cat}: weight must be numeric")
            elif w < 0:
                issues.append(f"{prefix}.{cat}: weight cannot be negative")
    return issues


def lint_intent_config(core_path: Path | None = None, plugin_dir: Path | str | None = None) -> list[str]:
    """Validate IntentEnvelope config. Returns list of error/warning strings (empty = OK)."""
    issues: list[str] = []

    try:
        cfg = load_config_with_plugins(core_path=core_path, plugin_dir=plugin_dir)
    except Exception as e:
        issues.append(f"Config load failed: {e}")
        return issues

    # 1. Thresholds
    th = cfg.get("thresholds") or {}
    if isinstance(th, dict):
        for name, default in (
            ("easy_max", 4),
            ("medium_max", 15),
            ("density_threshold", 3),
            ("density_tax", 10),
            ("risk_high", 15),
        ):
            val = th.get(name)
            if val is None and name != "risk_high":
                issues.append(f"thresholds.{name} missing (expected int, default {default})")
            elif val is not None and not isinstance(val, (int, float)):
                issues.append(f"thresholds.{name} must be numeric, got {type(val).__name__}")
            elif val is not None and name in ("easy_max", "medium_max") and val < 0:
                issues.append(f"thresholds.{name} cannot be negative")
    else:
        issues.append("thresholds must be a dict")

    # 2. At least one of: complexity_weights, risk_weights, domain_keywords
    cw = cfg.get("complexity_weights") or {}
    rw = cfg.get("risk_weights") or {}
    dk = cfg.get("domain_keywords") or {}
    if not cw and not rw and not dk:
        issues.append("Config must have complexity_weights, risk_weights, or domain_keywords")

    issues.extend(_lint_weights(cw, "complexity_weights"))
    issues.extend(_lint_weights(rw, "risk_weights"))
    for cat, data in (dk or {}).items():
        if not isinstance(data, dict):
            issues.append(f"domain_keywords.{cat}: must be dict")
        elif not isinstance(data.get("keywords"), list) or len(data.get("keywords", [])) == 0:
            issues.append(f"domain_keywords.{cat}: must have non-empty keywords list")

    # 3. Pairings
    pairings = cfg.get("pairings") or []
    if isinstance(pairings, list):
        for i, p in enumerate(pairings):
            if not isinstance(p, dict):
                issues.append(f"pairings[{i}]: must be dict")
                continue
            kw = p.get("keywords")
            if not isinstance(kw, list) or len(kw) < 2:
                issues.append(f"pairings[{i}]: must have 'keywords' list with >= 2 items")
            ew = p.get("extra_weight")
            if ew is not None and not isinstance(ew, (int, float)):
                issues.append(f"pairings[{i}]: extra_weight must be numeric")
    else:
        issues.append("pairings must be a list")

    # 4. Overrides
    overrides = cfg.get("overrides") or {}
    if isinstance(overrides, dict):
        for k, v in overrides.items():
            if not isinstance(v, list):
                issues.append(f"overrides.{k}: must be list of strings, got {type(v).__name__}")
            else:
                for j, item in enumerate(v):
                    if not isinstance(item, str):
                        issues.append(f"overrides.{k}[{j}]: must be string, got {type(item).__name__}")
    else:
        issues.append("overrides must be a dict")

    if issues:
        logger.warning("intent_config_lint issues=%s", issues)
    return issues
