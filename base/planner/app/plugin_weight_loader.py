"""PluginWeightLoader — merge core + industry-specific YAMLs at startup.

v3 format: complexity_weights, risk_weights, domain_keywords (domain never escalates).
Supports ontology.v3 namespacing.

Merge rules:
  - complexity_weights / risk_weights / domain_keywords: merged per axis
  - pairings: append; axis: risk|complexity
  - overrides: per-key merge
  - thresholds: later overrides
"""

from __future__ import annotations

import glob
import logging
import os
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


def _extract_ontology(raw: dict[str, Any]) -> dict[str, Any]:
    """Extract ontology.v3 if present; else return raw."""
    ont = raw.get("ontology")
    if isinstance(ont, dict) and "v3" in ont:
        return dict(ont["v3"])
    return raw


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


def _merge_weights(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Merge weight dicts: later overlay overwrites same category names."""
    result = dict(base)
    result.update(overlay)
    return result


def load_config_with_plugins(
    core_path: Path | None = None,
    plugin_dir: Path | str | None = None,
) -> dict[str, Any]:
    """Load core config and merge all plugin YAMLs. Returns unified config with split axes."""
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

    raw = _load_yaml(Path(core_path)) if core_path else {}
    merged = _extract_ontology(raw)

    complexity_weights = dict(merged.get("complexity_weights", {}))
    risk_weights = dict(merged.get("risk_weights", {}))
    domain_keywords = dict(merged.get("domain_keywords", {}))
    intent_classes = dict(merged.get("intent_classes", {}))
    master_pairings = list(merged.get("pairings", []))
    master_overrides = dict(merged.get("overrides", {}))
    master_thresholds = dict(merged.get("thresholds", {}))
    risk_veto_triggers = list(merged.get("risk_veto_triggers", []))
    vertical_prompts = {}

    # Filter plugins by compose.enabled_plugins or SYNESIS_ENTRY_CLASSIFIER_PLUGINS
    enabled = merged.get("compose", {}).get("enabled_plugins")
    if enabled is None:
        env_plugins = os.environ.get("SYNESIS_ENTRY_CLASSIFIER_PLUGINS")
        enabled = env_plugins.split(",") if env_plugins else None

    plugin_files = sorted(glob.glob(str(plugin_dir_path / "*.yaml")))
    for pf in plugin_files:
        if "intent_weights" in pf or "entry_classifier_weights" in pf:
            continue
        plug_name = Path(pf).stem
        if enabled is not None and plug_name not in enabled:
            continue
        plug = _load_yaml(Path(pf))
        if not plug:
            continue
        plug = _extract_ontology(plug)
        if plug.get("complexity_weights"):
            complexity_weights = _merge_weights(complexity_weights, plug["complexity_weights"])
        if plug.get("risk_weights"):
            risk_weights = _merge_weights(risk_weights, plug["risk_weights"])
        if plug.get("domain_keywords"):
            domain_keywords = _merge_weights(domain_keywords, plug["domain_keywords"])
        master_pairings.extend(plug.get("pairings", []))
        if plug.get("overrides"):
            master_overrides = _merge_overrides(master_overrides, plug["overrides"])
        if plug.get("thresholds"):
            master_thresholds = _merge_thresholds(master_thresholds, plug["thresholds"])
        if plug.get("risk_veto_triggers"):
            risk_veto_triggers.extend(plug["risk_veto_triggers"])
        if plug.get("intent_classes"):
            intent_classes = _merge_weights(intent_classes, plug["intent_classes"])
        if plug.get("vertical_prompt"):
            vp = plug["vertical_prompt"]
            vp_name = vp.get("name", "")
            if vp_name:
                vertical_prompts[vp_name] = vp
        logger.debug("plugin_loaded path=%s", pf)

    return {
        "complexity_weights": complexity_weights,
        "risk_weights": risk_weights,
        "domain_keywords": domain_keywords,
        "intent_classes": intent_classes,
        "pairings": master_pairings,
        "overrides": master_overrides,
        "thresholds": master_thresholds,
        "risk_veto_triggers": risk_veto_triggers,
        "vertical_prompts": vertical_prompts,
    }
