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
    required_elements = list(node_cfg.get("required_elements") or ["Direct Answer"])
    required_bullets = len(required_elements)

    # Override complexity from scorer when available
    if complexity_score and 0 <= complexity_score <= 1:
        complexity = max(complexity, complexity_score)

    # task_size modifier: complex → boost, trivial → dampen
    if task_size == "complex":
        complexity = min(1.0, complexity + 0.1)
    elif task_size == "trivial":
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


def get_worker_explain_tone(metadata: dict[str, Any]) -> str:
    """Return domain-specific explain-only tone from taxonomy config, or empty string for default."""
    if not metadata:
        return ""
    return (metadata.get("worker_explain_tone") or "").strip()


def get_executor_depth_block(metadata: dict[str, Any]) -> str:
    """Return block to inject into Worker/Executor prompt. Taxonomy-aware."""
    if not metadata:
        return ""
    depth = (metadata.get("depth_instructions") or "").strip()
    if not depth:
        return ""
    return f"\n\nTaxonomy depth: {depth}"


def should_plan_for_document(metadata: dict[str, Any], active_domain_refs: list[str]) -> bool:
    """When output_type=document, should we route to Planner for structured bullets?"""
    if not metadata:
        return False
    cfg = _load_config()
    deep_dive = set(cfg.get("deep_dive_domains") or [])
    complexity = float(metadata.get("complexity_score", 0.5))
    key = metadata.get("taxonomy_key", "")
    refs = {str(r).lower() for r in (active_domain_refs or [])}
    return bool(key in deep_dive and complexity > 0.6) or bool(refs & deep_dive and complexity > 0.6)


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
