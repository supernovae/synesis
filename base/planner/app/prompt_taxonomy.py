"""Prompt taxonomy — resolve (intent × vertical × task_size) → prompt components.

Links router taxonomy to prompt selection. Loads prompt_taxonomy.yaml.
Used by history_summarizer for pivot summary bias and future prompt consumers.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("synesis.prompt_taxonomy")

_CONFIG_PATH = Path(__file__).parent.parent / "prompt_taxonomy.yaml"
_cached: dict[str, Any] | None = None


def _load_config() -> dict[str, Any]:
    global _cached
    if _cached is not None:
        return _cached
    try:
        import yaml

        if _CONFIG_PATH.exists():
            with open(_CONFIG_PATH) as f:
                _cached = yaml.safe_load(f) or {}
        else:
            _cached = {}
    except Exception as e:
        logger.warning("prompt_taxonomy_load_failed path=%s error=%s", _CONFIG_PATH, e)
        _cached = {}
    return _cached


def get_prompt_components(
    intent_class: str = "code",
    vertical: str = "generic",
    task_size: str = "small",
) -> dict[str, Any]:
    """Resolve prompt components for (intent × vertical × task_size).

    Merges default, by_intent, by_vertical, by_task_size. Later overrides earlier.
    Returns dict with keys: summary_depth, summary_domain_focus, evidence_emphasis.
    """
    cfg = _load_config()
    router = cfg.get("router_to_prompt") or {}
    components = cfg.get("prompt_components") or {}

    default = router.get("default") or {}
    by_intent = router.get("by_intent") or {}
    by_vertical = router.get("by_vertical") or {}
    by_task_size = router.get("by_task_size") or {}

    out: dict[str, Any] = dict(default)
    if intent_class and intent_class in by_intent:
        out.update({k: v for k, v in (by_intent[intent_class] or {}).items() if v is not None})
    if vertical and vertical in by_vertical:
        out.update({k: v for k, v in (by_vertical[vertical] or {}).items() if v is not None})
    if task_size and task_size in by_task_size:
        out.update({k: v for k, v in (by_task_size[task_size] or {}).items() if v is not None})

    return out


def get_summary_domain_suffix_key(vertical: str) -> str:
    """Return the domain_suffix_by_vertical key for the given vertical.

    Used by pivot summarizer to pick the right suffix from approach_dark_debt_config.
    """
    cfg = _load_config()
    mapping = cfg.get("vertical_to_summary_suffix_key") or {}
    return mapping.get(vertical) or mapping.get("generic") or "generic"


def clear_cache() -> None:
    """Reset cached config. Use in tests."""
    global _cached
    _cached = None
