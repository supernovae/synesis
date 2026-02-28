"""EntryClassifier node -- deterministic IntentEnvelope before any LLM.

Runs first on every request. Uses regex + rules to set 5–8 fields the whole
graph obeys. Supervisor executes policy; it does not discover it.

Step 0 of incremental rollout: stops "I need more info…" for trivial tasks.
Uses DefaultsPolicy for trivial defaults (code constants + YAML overrides).
"""

from __future__ import annotations

import re
from typing import Any, Literal

from ..defaults_policy import get_defaults_policy

TaskSize = Literal["trivial", "small", "complex"]
MessageOrigin = Literal["end_user", "ui_helper", "system_internal", "tool_log"]

# Language detection (ordered: more specific first)
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

# Trivial triggers — high confidence, no questions
_TRIVIAL_PATTERNS = [
    re.compile(r"\bhello\s+world\b", re.IGNORECASE),
    re.compile(r"\bprint\s+['\"]?\w+['\"]?\s*\)?\s*$", re.IGNORECASE),
    re.compile(r"^print\s+", re.IGNORECASE),
    re.compile(r"\bwrite\s+a\s+(?:simple\s+)?script\s+that\s+prints?\b", re.IGNORECASE),
    re.compile(r"\bbasic\s+(?:unit\s+)?test\b", re.IGNORECASE),
    re.compile(r"\badd\s+a\s+unit\s+test\s+for\b", re.IGNORECASE),
    re.compile(r"\bunit\s+test\s+for\s+(?:this\s+)?function\b", re.IGNORECASE),
    re.compile(r"\bparse\s+json\b", re.IGNORECASE),
    re.compile(r"\bparse\s+this\s+json\b", re.IGNORECASE),
    re.compile(r"\bread\s+a\s+file\s+and\s+(?:print|count)\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+a\s+function\s+that\s+returns\s+\d+\b", re.IGNORECASE),
    re.compile(r"\bsimple\s+fizzbuzz\b", re.IGNORECASE),
    re.compile(r"\bfizzbuzz\b", re.IGNORECASE),
    re.compile(r"\bbasic\s+script\b", re.IGNORECASE),
    re.compile(r"^create\s+a\s+(?:simple\s+)?(?:python\s+)?(?:script|file)\s+that\s+(?:prints?|says)\b", re.IGNORECASE),
    re.compile(r"\bminimal\s+(?:hello|example)\b", re.IGNORECASE),
    re.compile(r"\b(?:how\s+to\s+)?(?:build|create|write)\s+a\s+(?:simple\s+)?(?:hello\s+world|python)\s+(?:app|script|example)\b", re.IGNORECASE),
]

# Complex escalation — only with clear signals
_COMPLEX_PATTERNS = [
    re.compile(r"\bdeploy\b|\barchitecture\b|\bdesign\b|\bmigrate\b|\brefactor\s+across\b", re.IGNORECASE),
    re.compile(r"\bsecurity\b|\bauth\b|\bpayments?\b|\bcredentials?\b", re.IGNORECASE),
    re.compile(r"\bconnect\s+to\s+(?:aws|gcp|s3|api)\b", re.IGNORECASE),
    re.compile(r"\bwhole\s+repo\b|\bentire\s+codebase\b|\badd\s+feature\s+.*\s+across\s+modules\b", re.IGNORECASE),
    re.compile(r"\bdelete\b.*\ball\b|\bwipe\b|\brotate\s+keys\b", re.IGNORECASE),
    re.compile(r"\bfix\s+my\s+project\b|\bmake\s+this\s+work\b", re.IGNORECASE),  # Ambiguous scope
]

# Educational/mentor intent — user wants explanation, not just code
_EDUCATIONAL_PATTERNS = [
    re.compile(r"\bexplain\b", re.IGNORECASE),
    re.compile(r"\bhow\s+does\s+(?:it|that|this)\s+work\b", re.IGNORECASE),
    re.compile(r"\bwhy\s+(?:did|do|would)\s+", re.IGNORECASE),
    re.compile(r"\bwalk\s+me\s+through\b", re.IGNORECASE),
    re.compile(r"\bteach\s+me\b", re.IGNORECASE),
    re.compile(r"\bi['\u2019]m\s+learning\b", re.IGNORECASE),
    re.compile(r"\blearn(?:ing)?\s+(?:how|to)\b", re.IGNORECASE),
    re.compile(r"\bwhat\s+does\s+(?:this|that|it)\s+(?:do|mean)\b", re.IGNORECASE),
    re.compile(r"\bcan\s+you\s+explain\b", re.IGNORECASE),
]

# UI helper (already filtered in main.py; double-check for graph routing)
_UI_HELPER_PATTERNS = [
    re.compile(r"suggest\s+(3[- ]?5\s+)?follow[- ]?up\s+questions?", re.IGNORECASE),
    re.compile(r"output\s+must\s+be\s+(?:a\s+)?JSON\s+array", re.IGNORECASE),
    re.compile(r"###\s*Task:\s*(?:Suggest|Generate)\s+", re.IGNORECASE),
]

DEFAULT_LANGUAGE = "python"


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


def _classify_task_size(text: str) -> TaskSize:
    """3-tier: trivial (fast path), small (default), complex (escalate)."""
    if not text or not text.strip():
        return "small"
    t = text.strip()[:800]

    # Complex first — explicit escalation
    for pat in _COMPLEX_PATTERNS:
        if pat.search(t):
            return "complex"

    # Trivial — high confidence
    for pat in _TRIVIAL_PATTERNS:
        if pat.search(t):
            return "trivial"

    return "small"


def _is_educational_intent(text: str) -> bool:
    """User wants explanation/teaching, not just code."""
    if not text or not text.strip():
        return False
    t = text.strip()[:600]
    return any(pat.search(t) for pat in _EDUCATIONAL_PATTERNS)


def _trivial_touched_files(text: str, target_language: str) -> list[str]:
    """Default touched_files for trivial tasks (from DefaultsPolicy)."""
    policy = get_defaults_policy()
    t = (text or "").lower()
    include_tests = "test" in t or "unit test" in t or "pytest" in t
    return policy.get_trivial_files(target_language, include_tests=include_tests)


def entry_classifier_node(state: dict[str, Any]) -> dict[str, Any]:
    """Deterministic pre-pass: produce IntentEnvelope fields before any LLM."""
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
    task_size = _classify_task_size(last_content)
    target_language = _detect_language(last_content)
    educational_mode = _is_educational_intent(last_content)

    # Bypass Supervisor for trivial; else Supervisor runs
    bypass_supervisor = task_size == "trivial"
    bypass_planner = task_size == "trivial"
    # Hard fence: trivial/small never ask; complex may (Supervisor decides)
    requires_clarification = task_size == "complex"

    # plan_required: from DefaultsPolicy (trivial/small typically false)
    policy = get_defaults_policy()
    if task_size == "trivial":
        plan_required = policy.plan_required_for_trivial
    elif task_size == "small":
        plan_required = policy.plan_required_for_small
    else:
        plan_required = True

    # clarification_budget: 0 trivial, 1 small, 2 complex (design §8)
    clarification_budget = 0 if task_size == "trivial" else (1 if task_size == "small" else 2)

    out: dict[str, Any] = {
        "message_origin": message_origin,
        "task_size": task_size,
        "target_language": target_language,
        "bypass_supervisor": bypass_supervisor,
        "bypass_planner": bypass_planner,
        "requires_clarification": requires_clarification,
        "plan_required": plan_required,
        "clarification_budget": clarification_budget,
        "interaction_mode": "teach" if educational_mode else "do",
        "intent_classifier_source": "deterministic",
    }

    if task_size == "trivial":
        out["task_is_trivial"] = True
        out["rag_mode"] = "disabled"
        out["task_description"] = (last_content or "").strip()[:500]
        out["touched_files"] = _trivial_touched_files(last_content, target_language)
        out["defaults_used"] = policy.get_defaults_used(target_language)
        out["deliverable_type"] = "single_file"
        out["include_tests"] = True
        out["include_run_commands"] = True
        out["task_type"] = "code_generation"
        out["allowed_tools"] = ["sandbox"]
        # Trivial default is "do"; override if educational intent
        if not educational_mode:
            out["interaction_mode"] = "do"

    return out
