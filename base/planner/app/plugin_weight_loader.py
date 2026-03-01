"""PluginWeightLoader — merge core + industry-specific YAMLs at startup.

Drop industry "Rules of Law" into plugins/weights/*.yaml and Synesis
automatically absorbs them. Supports Sovereign Intersection: when two
high-gravity verticals (e.g. HIPAA + K8s) are detected, both domains
are tracked for RAG/Context Curator coordination.

Merge rules:
  - weights: later plugins override same category names
  - pairings: append (plugins add risk multipliers + domain disambiguators)
  - overrides: per-key merge (force_manual, force_teach, etc.)
  - thresholds: later overrides
"""

from __future__ import annotations

import glob
import logging
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger("synesis.entry_classifier")

_PLANNER_ROOT = Path(__file__).parent.parent
_DEFAULT_PLUGIN_DIR = _PLANNER_ROOT / "plugins" / "weights"


def _load_yaml(path: Path) -> dict[str, Any]:
    """Load and parse YAML. Returns empty dict on error."""
    if not path.exists():
        return {}
    try:
        with open(path) as f:
            data = yaml.safe_load(f)
        return dict(data) if isinstance(data, dict) else {}
    except Exception as e:
        logger.warning("plugin_load_failed path=%s error=%s", path, e)
        return {}


def _merge_overrides(base: dict[str, list[str]], overlay: dict[str, list[str]]) -> dict[str, list[str]]:
    """Merge override dicts: overlay extends base per key."""
    result = dict(base)
    for k, v in overlay.items():
        if isinstance(v, list):
            result[k] = list(result.get(k, [])) + list(v)
    return result


def _merge_thresholds(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Later overlay overrides base threshold values."""
    result = dict(base)
    for k, v in overlay.items():
        if v is not None:
            result[k] = v
    return result


def load_config_with_plugins(
    core_path: Path | None = None,
    plugin_dir: Path | str | None = None,
) -> dict[str, Any]:
    """Load core config and merge all plugin YAMLs. Returns unified config."""
    if core_path is None:
        for name in ("intent_weights.yaml", "entry_classifier_weights.yaml"):
            p = _PLANNER_ROOT / name
            if p.exists():
                core_path = p
                break
        if core_path is None:
            core_path = _PLANNER_ROOT / "intent_weights.yaml"

    plugin_dir_path = Path(plugin_dir) if plugin_dir else _DEFAULT_PLUGIN_DIR
    if not plugin_dir_path.is_absolute():
        plugin_dir_path = _PLANNER_ROOT / plugin_dir_path

    # 1. Load core
    merged: dict[str, Any] = _load_yaml(Path(core_path)) if core_path else {}
    if not merged:
        merged = {
            "thresholds": {"trivial_max": 4, "small_max": 15, "density_threshold": 3, "density_tax": 10, "educational_discount": 10},
            "pairings": [],
            "weights": {"io_basic": {"weight": 1, "keywords": ["print", "hello"]}, "logic_basic": {"weight": 2, "keywords": ["basic", "simple"]}},
            "overrides": {"force_manual": ["[STRICT]", "/plan"], "force_teach": ["explain", "teach"], "force_pro_advanced": ["plan first"]},
        }

    master_weights = dict(merged.get("weights", {}))
    master_pairings = list(merged.get("pairings", []))
    master_overrides = dict(merged.get("overrides", {}))
    master_thresholds = dict(merged.get("thresholds", {}))

    # 2. Load and merge plugins (sorted for deterministic order)
    plugin_files = sorted(glob.glob(str(plugin_dir_path / "*.yaml")))
    for pf in plugin_files:
        # Skip core-like names
        if "intent_weights" in pf or "entry_classifier_weights" in pf:
            continue
        plug = _load_yaml(Path(pf))
        if not plug:
            continue
        # Merge weights (update)
        master_weights.update(plug.get("weights", {}))
        # Extend pairings
        master_pairings.extend(plug.get("pairings", []))
        # Merge overrides
        if plug.get("overrides"):
            master_overrides = _merge_overrides(master_overrides, plug["overrides"])
        # Merge thresholds
        if plug.get("thresholds"):
            master_thresholds = _merge_thresholds(master_thresholds, plug["thresholds"])
        logger.debug("plugin_loaded path=%s", pf)

    return {
        "weights": master_weights,
        "pairings": master_pairings,
        "overrides": master_overrides,
        "thresholds": master_thresholds,
    }
