"""ScoringEngine for EntryClassifier — YAML-driven complexity scoring.

Universal Intent Ontology v2: Signal aggregation by risk/blast-radius, not
language. Supports pairings (risk multipliers), density tax (3+ domains),
and educational discount.

Plugin system: Drop industry YAMLs into plugins/weights/*.yaml and Synesis
absorbs them at startup. See plugin_weight_loader.py.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Literal

import yaml

logger = logging.getLogger("synesis.entry_classifier")

TaskSize = Literal["trivial", "small", "complex"]

# Prefer intent_weights.yaml (v2 ontology), fallback to entry_classifier_weights.yaml
_PLANNER_ROOT = Path(__file__).parent.parent
_PLUGIN_DIR = _PLANNER_ROOT / "plugins" / "weights"


def _resolve_config_path(explicit: str | Path | None) -> Path | None:
    """Resolve core config path: explicit > intent_weights > entry_classifier_weights."""
    if explicit:
        p = Path(explicit)
        if p.exists():
            return p
    for name in ("intent_weights.yaml", "entry_classifier_weights.yaml"):
        candidate = _PLANNER_ROOT / name
        if candidate.exists():
            return candidate
    return _PLANNER_ROOT / "intent_weights.yaml"


def _load_config(path: Path | str) -> dict[str, Any]:
    """Load YAML config. Returns built-in minimal fallback if file missing."""
    p = Path(path)
    if not p.exists():
        logger.debug("entry_classifier_weights not found at %s, using built-in fallback", p)
        return _builtin_fallback()
    try:
        with open(p) as f:
            data = yaml.safe_load(f)
        return dict(data) if isinstance(data, dict) else _builtin_fallback()
    except Exception as e:
        logger.warning("entry_classifier_weights load failed: %s, using built-in fallback", e)
        return _builtin_fallback()


def _load_config_with_plugins(core_path: Path | None, plugin_dir: Path) -> dict[str, Any] | None:
    """Load core + all plugin YAMLs. Returns None if plugin dir empty (use single-file)."""
    import os
    if os.environ.get("SYNESIS_ENTRY_CLASSIFIER_PLUGINS_DISABLED", "").lower() in ("1", "true", "yes"):
        return None
    if not plugin_dir.exists():
        return None
    plugin_files = list(plugin_dir.glob("*.yaml"))
    if not plugin_files:
        return None
    try:
        from .plugin_weight_loader import load_config_with_plugins
        return load_config_with_plugins(core_path=core_path, plugin_dir=plugin_dir)
    except Exception as e:
        logger.warning("plugin_load_failed error=%s, falling back to core only", e)
        return None


def _builtin_fallback() -> dict[str, Any]:
    """Minimal built-in config when YAML missing. Keeps trivial/small/complex working."""
    return {
        "thresholds": {"trivial_max": 4, "small_max": 15, "density_threshold": 3, "density_tax": 10, "educational_discount": 10},
        "pairings": [],
        "weights": {
            "io_basic": {"weight": 1, "keywords": ["print", "hello"]},
            "logic_basic": {"weight": 2, "keywords": ["basic", "simple"]},
            "data_processing": {"weight": 5, "keywords": ["parse", "json", "api"]},
            "infrastructure": {"weight": 15, "keywords": ["deploy", "docker"]},
        },
        "overrides": {
            "force_manual": ["[STRICT]", "/plan", "/manual", "/strict", "@plan"],
            "force_teach": ["explain", "teach", "how does it work", "why"],
            "force_pro_advanced": ["plan first", "break it down"],
        },
    }


class ScoringEngine:
    """YAML-driven complexity scorer. Deterministic, no LLM."""

    def __init__(self, config_path: str | Path | None = None):
        path = _resolve_config_path(config_path)
        plugin_config = _load_config_with_plugins(path, _PLUGIN_DIR)
        if plugin_config:
            self._config = {**plugin_config, "weights": plugin_config["weights"], "pairings": plugin_config["pairings"],
                           "overrides": plugin_config["overrides"], "thresholds": plugin_config["thresholds"]}
            logger.info("entry_classifier_plugins_loaded plugins_dir=%s", _PLUGIN_DIR)
        else:
            self._config = _load_config(path)
        self._weights = self._config.get("weights", {})
        self._overrides = self._config.get("overrides", {})
        self._pairings = self._config.get("pairings", [])
        self._thresholds = self._config.get("thresholds", {})

        # Pre-compile keyword patterns: \b(key1|key2|...)\b
        self._patterns: dict[str, tuple[int, re.Pattern[str]]] = {}
        for cat, data in self._weights.items():
            if isinstance(data, dict) and "keywords" in data and "weight" in data:
                keywords = data["keywords"]
                weight = int(data["weight"])
                escaped = [re.escape(k) for k in keywords]
                pattern = re.compile(
                    r"\b(" + "|".join(escaped) + r")\b",
                    re.IGNORECASE,
                )
                self._patterns[cat] = (weight, pattern)

        self._trivial_max = int(self._thresholds.get("trivial_max", 4))
        self._small_max = int(self._thresholds.get("small_max", 15))
        self._density_threshold = int(self._thresholds.get("density_threshold", 3))
        self._density_tax = int(self._thresholds.get("density_tax", 10))
        self._educational_discount = int(self._thresholds.get("educational_discount", 10))

    def _check_override(self, text: str, override_name: str) -> bool:
        """Check if any trigger in override list matches. Handles /plan at start."""
        triggers = self._overrides.get(override_name, [])
        if not triggers:
            return False
        t = (text or "").strip()[:800]
        if not t:
            return False
        t_lower = t.lower()
        for trigger in triggers:
            trigger = str(trigger).strip()
            if not trigger:
                continue
            # Triggers starting with /, @, #: start OR anywhere (e.g. "hello @plan")
            if trigger.startswith(("/", "@", "#")):
                if t_lower.startswith(trigger.lower()):
                    return True
                if re.match(rf"^[^\w]*{re.escape(trigger)}[\s:]", t_lower):
                    return True
                if trigger.lower() in t_lower:
                    return True
            # [STRICT] etc: substring match
            elif trigger.lower() in t_lower:
                return True
        return False

    def analyze(self, text: str) -> dict[str, Any]:
        """Score text and return IntentEnvelope params (task_size, score, overrides)."""
        t = (text or "").strip()[:800]
        if not t:
            return {
                "task_size": "small",
                "score": 0,
                "manual_override": False,
                "interaction_mode": "do",
                "force_pro_advanced": False,
                "classification_hits": [],
                "categories_touched": [],
                "active_domains": [],
            }

        # 1. Force manual (highest priority) — route through Supervisor
        if self._check_override(t, "force_manual"):
            return {
                "task_size": "complex",
                "score": 99,
                "manual_override": True,
                "interaction_mode": "teach" if self._check_override(t, "force_teach") else "do",
                "force_pro_advanced": True,
                "classification_hits": ["force_manual"],
                "categories_touched": [],
                "active_domains": [],
            }

        # 2. Force teach (and track for educational discount)
        interaction_mode = "teach" if self._check_override(t, "force_teach") else "do"
        force_pro_advanced = self._check_override(t, "force_pro_advanced")

        # 3. Base score from keyword weights + track categories
        score = 0
        hits: list[str] = []
        hits_by_category: dict[str, list[str]] = {}
        t_lower = t.lower()
        for cat, (weight, pattern) in self._patterns.items():
            matches = pattern.findall(t_lower)
            if matches:
                score += weight
                hits.append(f"{cat}(+{weight})")
                hits_by_category[cat] = list(set(matches))

        # 4. Contextual risk multipliers + domain pairings (composite triggers)
        active_domains: list[str] = []
        for cat in hits_by_category:
            # Categories can declare domain (e.g. compliance_healthcare -> healthcare_compliance)
            cat_data = self._weights.get(cat, {})
            if isinstance(cat_data, dict) and cat_data.get("domain"):
                d = str(cat_data["domain"]).strip()
                if d and d not in active_domains:
                    active_domains.append(d)
        for pair in self._pairings:
            kw_list = pair.get("keywords", [])
            if not kw_list:
                continue
            matches = all(re.search(rf"\b{re.escape(k)}\b", t_lower) for k in kw_list)
            if not matches:
                continue
            extra = int(pair.get("extra_weight", 0))
            if extra:
                score += extra
                hits.append(f"pairing({kw_list})(+{extra})")
            # Composite trigger: disambiguate e.g. cluster+pod->kubernetes, cluster+patient->healthcare
            domain = pair.get("domain")
            if domain and isinstance(domain, str):
                d = str(domain).strip()
                if d and d not in active_domains:
                    active_domains.append(d)

        # 5. Cross-domain density tax (3+ categories → +10)
        domain_count = len(hits_by_category)
        if domain_count >= self._density_threshold:
            score += self._density_tax
            hits.append(f"density_tax(+{self._density_tax})")

        # 6. Educational discount (informational query, low risk)
        if interaction_mode == "teach":
            score -= self._educational_discount
            hits.append(f"teach_discount(-{self._educational_discount})")

        score = max(0, score)

        # 7. Map score to task_size
        if score <= self._trivial_max:
            task_size: TaskSize = "trivial"
        elif score <= self._small_max:
            task_size = "small"
        else:
            task_size = "complex"

        return {
            "task_size": task_size,
            "score": score,
            "manual_override": False,
            "interaction_mode": interaction_mode,
            "force_pro_advanced": force_pro_advanced,
            "classification_hits": hits,
            "categories_touched": list(hits_by_category.keys()),
            "active_domains": active_domains,
        }


# Singleton for hot path (reset for tests via reset_scoring_engine)
_engine: ScoringEngine | None = None


def get_scoring_engine(config_path: str | Path | None = None) -> ScoringEngine:
    """Lazy-load singleton ScoringEngine."""
    global _engine
    if _engine is None:
        _engine = ScoringEngine(config_path)
    return _engine


def reset_scoring_engine() -> None:
    """Reset singleton. Use in tests to force reload or switch config."""
    global _engine
    _engine = None
