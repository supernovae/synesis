"""EntryClassifier node — deterministic IntentEnvelope before any LLM.

Runs first on every request. Uses YAML-driven ScoringEngine (keyword-weight map)
to set task_size, plus overrides. Supervisor executes policy; it does not discover it.

Design: Tune complexity detection via entry_classifier_weights.yaml — no code
changes for new languages/frameworks. See docs/USERGUIDE.md for user triggers.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Literal

from ..defaults_policy import get_defaults_policy
from ..entry_classifier_engine import get_scoring_engine

TaskSize = Literal["trivial", "small", "complex"]
MessageOrigin = Literal["end_user", "ui_helper", "system_internal", "tool_log"]

# Language detection (ordered: more specific first) — keep in code or move to YAML later
_LANGUAGE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\btypescript\b", re.IGNORECASE), "typescript"),
    (re.compile(r"\bjavascript\b|\.js\b|\.jsx\b|\.mjs\b", re.IGNORECASE), "javascript"),
    (re.compile(r"\bpython\b|\.py\b|pytest\b|pip\b|fastapi\b|learning\s+python", re.IGNORECASE), "python"),
    (re.compile(r"\bgolang\b|\bgo\s+(?:lang|code|script)\b|\.go\b", re.IGNORECASE), "go"),
    (re.compile(r"\brust\b|\.rs\b", re.IGNORECASE), "rust"),
    (re.compile(r"\bjava\b(?!\s+script)|\.java\b", re.IGNORECASE), "java"),
    (re.compile(r"\bc#\b|csharp\b|\.cs\b", re.IGNORECASE), "csharp"),
    (re.compile(r"\bbash\b|shell\b|\.sh\b|sh script", re.IGNORECASE), "bash"),
]

# UI helper (already filtered in main.py; double-check for graph routing)
_UI_HELPER_PATTERNS = [
    re.compile(r"suggest\s+(3[- ]?5\s+)?follow[- ]?up\s+questions?", re.IGNORECASE),
    re.compile(r"output\s+must\s+be\s+(?:a\s+)?JSON\s+array", re.IGNORECASE),
    re.compile(r"###\s*Task:\s*(?:Suggest|Generate)\s+", re.IGNORECASE),
]

DEFAULT_LANGUAGE = "python"


def _weights_path() -> Path:
    """Resolve config path: env override, then intent_weights, then entry_classifier_weights."""
    env_path = os.environ.get("SYNESIS_ENTRY_CLASSIFIER_WEIGHTS")
    if env_path and Path(env_path).exists():
        return Path(env_path)
    root = Path(__file__).parent.parent.parent
    for name in ("intent_weights.yaml", "entry_classifier_weights.yaml"):
        p = root / name
        if p.exists():
            return p
    return root / "intent_weights.yaml"


def detect_language_deterministic(text: str) -> str:
    """Public: language from user request (regex/rules). Used for context-stability pivot detection."""
    return _detect_language(text or "")


def _classify_message_origin(text: str) -> MessageOrigin:
    """Classify message origin. UI-helper prompts routed away from coding workflow."""
    if not text or not text.strip():
        return "end_user"
    t = text.strip()[:600]
    for pat in _UI_HELPER_PATTERNS:
        if pat.search(t):
            return "ui_helper"
    return "end_user"


def _detect_language(text: str) -> str:
    """Best-effort language from user request."""
    if not text or not text.strip():
        return DEFAULT_LANGUAGE
    t = text.strip()[:800]
    for pat, lang in _LANGUAGE_PATTERNS:
        if pat.search(t):
            return lang
    return DEFAULT_LANGUAGE


def _trivial_wants_tests(text: str) -> bool:
    """User explicitly asked for tests. Don't assume tests for one-liners/simple scripts."""
    if not text or not text.strip():
        return False
    t = (text or "").lower()
    return bool(
        "test" in t or "unit test" in t or "pytest" in t or "how to test" in t or "validate" in t or "validation" in t
    )


def _trivial_touched_files(text: str, target_language: str) -> list[str]:
    """Default touched_files for trivial tasks (from DefaultsPolicy). Single file unless user wants tests."""
    policy = get_defaults_policy()
    include_tests = _trivial_wants_tests(text)
    return policy.get_trivial_files(target_language, include_tests=include_tests)


def entry_classifier_node(state: dict[str, Any]) -> dict[str, Any]:
    """Deterministic pre-pass: produce IntentEnvelope fields from ScoringEngine + overrides."""
    messages = state.get("messages", [])
    last_content = ""
    for m in reversed(messages):
        if hasattr(m, "content") and isinstance(getattr(m, "content", None), str):
            last_content = m.content or ""
            break
        if isinstance(m, dict) and m.get("content"):
            last_content = str(m["content"])
            break

    message_origin = _classify_message_origin(last_content)
    target_language = _detect_language(last_content)
    policy = get_defaults_policy()

    # ScoringEngine from YAML (entry_classifier_weights.yaml)
    config_path = _weights_path()
    engine = get_scoring_engine(config_path)
    analysis = engine.analyze(last_content)

    task_size: TaskSize = analysis["task_size"]
    manual_override = analysis.get("manual_override", False)
    force_pro_advanced = analysis.get("force_pro_advanced", False)

    # Bypass Supervisor for trivial; else Supervisor runs. Force manual overrides.
    bypass_supervisor = task_size == "trivial" and not manual_override
    bypass_planner = task_size == "trivial" and not manual_override
    requires_clarification = task_size == "complex"

    # plan_required
    if manual_override:
        plan_required = True
    elif task_size == "trivial":
        plan_required = policy.plan_required_for_trivial
    elif task_size == "small":
        plan_required = policy.plan_required_for_small
    else:
        plan_required = True

    # clarification_budget
    clarification_budget = 0 if task_size == "trivial" else (1 if task_size == "small" else 2)

    # worker_prompt_tier: trivial=minimal, small=defensive, full=JCS
    if force_pro_advanced or task_size == "complex":
        worker_prompt_tier = "full"
    elif task_size == "trivial":
        worker_prompt_tier = "trivial"
    else:
        worker_prompt_tier = "small"

    out: dict[str, Any] = {
        "message_origin": message_origin,
        "task_size": task_size,
        "target_language": target_language,
        "bypass_supervisor": bypass_supervisor,
        "bypass_planner": bypass_planner,
        "requires_clarification": requires_clarification,
        "plan_required": plan_required,
        "clarification_budget": clarification_budget,
        "interaction_mode": analysis.get("interaction_mode", "do"),
        "intent_classifier_source": "deterministic",
        "worker_prompt_tier": worker_prompt_tier,
    }
    # Sovereign intersection: deterministic domains from EntryClassifier seed active_domain_refs
    active_domains = analysis.get("active_domains") or []
    if active_domains:
        out["active_domain_refs"] = active_domains

    # Trivial fast-path fields — skip when manual_override (user wants Supervisor path)
    if task_size == "trivial" and not manual_override:
        out["task_is_trivial"] = True
        out["rag_mode"] = "disabled"
        out["task_description"] = (last_content or "").strip()[:500]
        out["touched_files"] = _trivial_touched_files(last_content, target_language)
        out["defaults_used"] = policy.get_defaults_used(target_language)
        out["deliverable_type"] = "single_file"
        out["include_tests"] = _trivial_wants_tests(last_content)
        out["include_run_commands"] = True
        out["task_type"] = "code_generation"
        out["allowed_tools"] = ["sandbox"]
        if out.get("interaction_mode") != "teach":
            out["interaction_mode"] = "do"

    return out
