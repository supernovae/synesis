"""Vertical resolver — maps active_domain_refs + platform_context to canonical vertical.

Used by Worker (persona injection), Planner (decomposition rules), Critic (mode selection).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("synesis.vertical_resolver")

_PLANNER_ROOT = Path(__file__).parent.parent
_VERTICAL_PROMPTS_PATH = _PLANNER_ROOT / "vertical_prompts.yaml"

_cached_config: dict[str, Any] | None = None


def _load_vertical_prompts() -> dict[str, Any]:
    global _cached_config
    if _cached_config is not None:
        return _cached_config
    try:
        import yaml

        if _VERTICAL_PROMPTS_PATH.exists():
            with open(_VERTICAL_PROMPTS_PATH) as f:
                raw = yaml.safe_load(f)
            _cached_config = raw or {}
        else:
            _cached_config = {}
    except Exception as e:
        logger.warning("vertical_prompts_load_failed path=%s error=%s", _VERTICAL_PROMPTS_PATH, e)
        _cached_config = {}
    return _cached_config


def resolve_active_vertical(
    active_domain_refs: list[str] | None = None,
    platform_context: str | None = None,
) -> str:
    """Resolve canonical vertical from domain refs and platform context.

    Returns: medical | fintech | industrial | platform | scientific | lifestyle | generic
    """
    refs = [r.strip().lower() for r in (active_domain_refs or []) if r and str(r).strip()]
    ctx = (platform_context or "").strip().lower() if platform_context else ""

    config = _load_vertical_prompts()
    verticals = config.get("verticals") or {}

    for vert_name, vert_data in verticals.items():
        if not isinstance(vert_data, dict):
            continue
        # Check active_domain_refs (e.g. healthcare_compliance, fintech_compliance)
        ref_list = [str(x).strip().lower() for x in (vert_data.get("active_domain_refs") or [])]
        for r in refs:
            if r in ref_list:
                return vert_name
            if any(r == ref or r in ref or ref in r for ref in ref_list):
                return vert_name
        # Check platform_context_aliases (e.g. openshift, kubernetes)
        aliases = [str(x).strip().lower() for x in (vert_data.get("platform_context_aliases") or [])]
        if ctx and (ctx in aliases or any(a in ctx or ctx in a for a in aliases)):
            return vert_name

    return "generic"


def get_worker_persona_block(vertical: str) -> str:
    """Return vertical-specific Worker persona block to append, or empty string."""
    config = _load_vertical_prompts()
    verticals = config.get("verticals") or {}
    vert_data = verticals.get(vertical) if vertical else None
    if not isinstance(vert_data, dict):
        return ""
    block = vert_data.get("worker_persona_block", "")
    return (block or "").strip()


def get_planner_decomposition_rules(vertical: str) -> str:
    """Return vertical-specific Planner decomposition rules to append."""
    config = _load_vertical_prompts()
    verticals = config.get("verticals") or {}
    vert_data = verticals.get(vertical) if vertical else None
    if not isinstance(vert_data, dict):
        return ""
    rules = vert_data.get("planner_decomposition_rules", "")
    return (rules or "").strip()


def get_critic_mode(vertical: str) -> str:
    """Return critic mode: safety_ii | tiered | advisory."""
    config = _load_vertical_prompts()
    verticals = config.get("verticals") or {}
    vert_data = verticals.get(vertical) if vertical else None
    if not isinstance(vert_data, dict):
        return "advisory"
    return (vert_data.get("critic_mode") or "advisory").strip().lower()


def get_critic_tier_prompt(vertical: str, tier: str) -> str:
    """For tiered critic (lifestyle): basic | advanced | research."""
    config = _load_vertical_prompts()
    verticals = config.get("verticals") or {}
    vert_data = verticals.get(vertical) if vertical else None
    if not isinstance(vert_data, dict):
        return ""
    tiers = vert_data.get("critic_tiers") or {}
    return (tiers.get(tier) or "").strip()


def clear_cache() -> None:
    """Reset cached config. Use in tests."""
    global _cached_config
    _cached_config = None
