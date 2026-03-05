"""Taxonomy-Driven Contextual Injection — PromptFactory from taxonomy state.

Maps router tags (active_domain_refs, intent_class) to TaxonomyNode metadata.
No new LLM — deterministic lookup from taxonomy_prompt_config.yaml.
Planner and Executor use this to shape prompts and depth.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("synesis.taxonomy_factory")

_CONFIG_PATH = Path(__file__).parent.parent / "taxonomy_prompt_config.yaml"
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
        logger.warning("taxonomy_prompt_config_load_failed path=%s error=%s", _CONFIG_PATH, e)
        _cached = {}
    return _cached


def resolve_taxonomy_metadata(
    active_domain_refs: list[str],
    task_size: str,
    intent_class: str,
    complexity_score: float = 0.5,
) -> dict[str, Any]:
    """Resolve TaxonomyNode from Entry Classifier output. No LLM.

    Uses active_domain_refs (e.g. physics, astronomy) + task_size + intent_class
    to lookup taxonomy_prompt_config. Returns TaxonomyNode dict for state.
    """
    cfg = _load_config()
    taxonomies = {k: v for k, v in (cfg or {}).items() if isinstance(v, dict) and "path" in v}

    # Pick first matching domain
    key = "generic"
    for ref in active_domain_refs or []:
        r = str(ref).strip().lower()
        if r in taxonomies:
            key = r
            break
        # Partial match (e.g. athletics_running → athletics)
        for k in taxonomies:
            if k in r or r in k:
                key = k
                break

    node_cfg = taxonomies.get(key) or taxonomies.get("generic") or {}
    path = str(node_cfg.get("path", "General"))
    complexity = float(node_cfg.get("complexity", 0.5))
    persona = str(node_cfg.get("persona", "Helpful Assistant"))
    depth_instructions = str(node_cfg.get("depth_instructions", "")).strip()
    worker_explain_tone = str(node_cfg.get("worker_explain_tone", "")).strip()
    discovery_prompt = str(node_cfg.get("discovery_prompt", "")).strip()
    required_elements = list(node_cfg.get("required_elements") or ["Direct Answer"])
    required_bullets = len(required_elements)

    # Override complexity from scorer when available.
    # ScoringEngine emits raw int (0-50+); normalize to 0.0-1.0 (cap at 50).
    if complexity_score and complexity_score > 0:
        normalized = min(1.0, float(complexity_score) / 50.0)
        complexity = max(complexity, normalized)

    # task_size modifier: hard → boost, easy → dampen
    if task_size == "hard":
        complexity = min(1.0, complexity + 0.1)
    elif task_size == "easy":
        complexity = max(0.1, complexity - 0.2)
        required_bullets = min(required_bullets, 2)

    persona_instructions = persona
    if complexity > 0.7 and depth_instructions:
        persona_instructions = f"{persona}. {depth_instructions}"

    return {
        "path": path,
        "complexity_score": complexity,
        "persona_instructions": persona_instructions,
        "required_bullets": required_bullets,
        "required_elements": required_elements,
        "depth_instructions": depth_instructions,
        "worker_explain_tone": worker_explain_tone,
        "discovery_prompt": discovery_prompt,
        "taxonomy_key": key,
    }


def get_planner_system_prompt_append(metadata: dict[str, Any]) -> str:
    """Return formatted string to append to Planner system prompt. Taxonomy-aware."""
    if not metadata:
        return ""
    complexity = float(metadata.get("complexity_score", 0.5))
    required_elements = metadata.get("required_elements") or []
    depth_instructions = (metadata.get("depth_instructions") or "").strip()

    parts = []
    if required_elements:
        elems = "; ".join(required_elements)
        parts.append(f"Your plan MUST include these sections/steps: {elems}.")
    if complexity > 0.7 and depth_instructions:
        parts.append(depth_instructions)
    if not parts:
        return ""
    return "\n\n" + " ".join(parts)


def _is_large_model() -> bool:
    """Check if model_capability_tier is 'large' — skip taxonomy injection for large models."""
    try:
        from .config import settings

        return getattr(settings, "model_capability_tier", "small") == "large"
    except Exception:
        return False


def get_worker_explain_tone(metadata: dict[str, Any]) -> str:
    """Return domain-specific explain-only tone from taxonomy config, or empty string for default."""
    if not metadata or _is_large_model():
        return ""
    return (metadata.get("worker_explain_tone") or "").strip()


def get_discovery_prompt(metadata: dict[str, Any]) -> str:
    """Return domain-specific discovery/enrichment prompt, or empty string."""
    if not metadata or _is_large_model():
        return ""
    return (metadata.get("discovery_prompt") or "").strip()


def get_executor_depth_block(metadata: dict[str, Any]) -> str:
    """Return block to inject into Worker/Executor prompt. Taxonomy-aware."""
    if not metadata or _is_large_model():
        return ""
    depth = (metadata.get("depth_instructions") or "").strip()
    if not depth:
        return ""
    return f"\n\nTaxonomy depth: {depth}"


def should_plan_for_document(metadata: dict[str, Any], active_domain_refs: list[str]) -> bool:
    """When needs_sandbox=False (explain-only), should we route to Planner for structured bullets?"""
    if not metadata:
        return False
    cfg = _load_config()
    deep_dive = set(cfg.get("deep_dive_domains") or [])
    complexity = float(metadata.get("complexity_score", 0.5))
    key = metadata.get("taxonomy_key", "")
    refs = {str(r).lower() for r in (active_domain_refs or [])}
    return bool(key in deep_dive and complexity > 0.6) or bool(refs & deep_dive and complexity > 0.6)


def _load_vertical_prompts() -> dict[str, Any]:
    """Load vertical prompts from plugin-merged config."""
    try:
        from .entry_classifier_engine import get_scoring_engine

        engine = get_scoring_engine()
        return engine._config.get("vertical_prompts") or {}
    except Exception:
        return {}


def _load_intent_prompts() -> dict[str, Any]:
    """Load intent critic behavior overlays from intent_prompts.yaml."""
    import yaml

    path = Path(__file__).parent.parent / "intent_prompts.yaml"
    try:
        if path.exists():
            with open(path) as f:
                raw = yaml.safe_load(f) or {}
            return raw
        return {}
    except Exception:
        return {}


_cached_intent_prompts: dict[str, Any] | None = None


def resolve_active_vertical(
    active_domain_refs: list[str] | None = None,
    platform_context: str | None = None,
) -> str:
    """Resolve canonical vertical from domain refs and platform context.

    Uses vertical_prompt data from taxonomy plugins (merged by plugin_weight_loader).
    Returns: medical | fintech | industrial | platform | scientific | lifestyle | generic
    """
    refs = [r.strip().lower() for r in (active_domain_refs or []) if r and str(r).strip()]
    ctx = (platform_context or "").strip().lower() if platform_context else ""

    verticals = _load_vertical_prompts()
    for vert_name, vert_data in verticals.items():
        if not isinstance(vert_data, dict):
            continue
        ref_list = [str(x).strip().lower() for x in (vert_data.get("active_domain_refs") or [])]
        for r in refs:
            if r in ref_list or any(r == ref or r in ref or ref in r for ref in ref_list):
                return vert_name
        aliases = [str(x).strip().lower() for x in (vert_data.get("platform_context_aliases") or [])]
        if ctx and (ctx in aliases or any(a in ctx or ctx in a for a in aliases)):
            return vert_name

    return "generic"


def get_worker_persona_block(vertical: str) -> str:
    """Return vertical-specific Worker persona block, or empty string."""
    verticals = _load_vertical_prompts()
    vert_data = verticals.get(vertical)
    if not isinstance(vert_data, dict):
        return ""
    return (vert_data.get("worker_persona_block") or "").strip()


def get_planner_decomposition_rules(vertical: str) -> str:
    """Return vertical-specific Planner decomposition rules."""
    verticals = _load_vertical_prompts()
    vert_data = verticals.get(vertical)
    if not isinstance(vert_data, dict):
        return ""
    return (vert_data.get("planner_decomposition_rules") or "").strip()


def get_critic_mode(vertical: str) -> str:
    """Return critic mode: safety_ii | tiered | advisory."""
    verticals = _load_vertical_prompts()
    vert_data = verticals.get(vertical)
    if not isinstance(vert_data, dict):
        return "advisory"
    return (vert_data.get("critic_mode") or "advisory").strip().lower()


def get_critic_tier_prompt(vertical: str, tier: str) -> str:
    """For tiered critic: basic | advanced | research."""
    verticals = _load_vertical_prompts()
    vert_data = verticals.get(vertical)
    if not isinstance(vert_data, dict):
        return ""
    tiers = vert_data.get("critic_tiers") or {}
    return (tiers.get(tier) or "").strip()


def get_intent_critic_block(intent_class: str) -> str:
    """Return intent-specific critic behavior overlay."""
    global _cached_intent_prompts
    if _cached_intent_prompts is None:
        _cached_intent_prompts = _load_intent_prompts()
    intent_classes = _cached_intent_prompts.get("intent_classes") or {}
    ic_data = intent_classes.get(intent_class) if intent_class else None
    if not isinstance(ic_data, dict):
        return ""
    return (ic_data.get("critic_behavior_block") or "").strip()


def get_critic_depth_prompt_block(metadata: dict[str, Any]) -> str:
    """Return prompt block for Critic science-depth validation. Taxonomy-aware."""
    if not metadata:
        return ""
    complexity = float(metadata.get("complexity_score", 0.5))
    required_elements = metadata.get("required_elements") or []
    depth_instructions = (metadata.get("depth_instructions") or "").strip()
    path = (metadata.get("path") or "").strip()

    if complexity < 0.6 or not required_elements:
        return ""

    parts = [
        "TAXONOMY DEPTH CHECK:",
        f"Domain path: {path}. Expected complexity: {complexity:.1f}.",
        f"The response MUST cover these sections: {'; '.join(required_elements)}.",
    ]
    if depth_instructions:
        parts.append(f"Depth expectations: {depth_instructions}")
    parts.append(
        "Evaluate: Does the response meet the required scientific/technical depth? "
        "Are the required_elements adequately addressed? "
        "If any element is missing or superficial, add a blocking_issue with ref_type=taxonomy_depth."
    )
    return "\n".join(parts)
