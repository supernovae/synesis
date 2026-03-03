"""EntryClassifier node — deterministic IntentEnvelope before any LLM.

Runs first on every request. Uses YAML-driven ScoringEngine (keyword-weight map)
to set task_size, plus overrides. Supervisor executes policy; it does not discover it.

Design: Tune complexity detection via entry_classifier_weights.yaml — no code
changes for new languages/frameworks. See docs/USERGUIDE.md for user triggers.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any, Literal

from ..defaults_policy import get_defaults_policy
from ..entry_classifier_engine import get_scoring_engine
from ..taxonomy_prompt_factory import resolve_taxonomy_metadata, should_plan_for_document

logger = logging.getLogger("synesis.entry_classifier")

TaskSize = Literal["trivial", "small", "complex"]
WorkerPersona = Literal["Minimalist", "Senior", "Architect"]
MessageOrigin = Literal["end_user", "ui_helper", "system_internal", "tool_log"]

# Persona Tier: Decouples engineering rigor from general utility
_TASK_SIZE_TO_PERSONA: dict[TaskSize, WorkerPersona] = {
    "trivial": "Minimalist",
    "small": "Senior",
    "complex": "Architect",
}

# Language detection (ordered: more specific first). Shell variants, IaC, programming languages.
_LANGUAGE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\btypescript\b|\.ts\b|\.tsx\b", re.IGNORECASE), "typescript"),
    (re.compile(r"\bjavascript\b|\.js\b|\.jsx\b|\.mjs\b", re.IGNORECASE), "javascript"),
    (re.compile(r"\bpython\b|\.py\b|pytest\b|pip\b|fastapi\b|learning\s+python", re.IGNORECASE), "python"),
    (re.compile(r"\bgolang\b|\bgo\s+(?:lang|code|script)\b|\.go\b", re.IGNORECASE), "go"),
    (re.compile(r"\brust\b|\.rs\b", re.IGNORECASE), "rust"),
    (re.compile(r"\bjava\b(?!\s+script)|\bkotlin\b|\.java\b|\.kt\b", re.IGNORECASE), "java"),
    (re.compile(r"\bc#\b|csharp\b|\.cs\b", re.IGNORECASE), "csharp"),
    (re.compile(r"\bswift\b|\.swift\b", re.IGNORECASE), "swift"),
    (re.compile(r"\bruby\b|\.rb\b", re.IGNORECASE), "ruby"),
    (re.compile(r"\bphp\b|\.php\b", re.IGNORECASE), "php"),
    (re.compile(r"\bpowershell\b|pwsh\b|\.ps1\b", re.IGNORECASE), "powershell"),
    (re.compile(r"\bbash\b|zsh\b|ksh\b|korn\s*shell\b|\.sh\b|sh script", re.IGNORECASE), "bash"),
]

# UI helper (already filtered in main.py; double-check for graph routing)
_UI_HELPER_PATTERNS = [
    re.compile(r"suggest\s+(3[- ]?5\s+)?follow[- ]?up\s+questions?", re.IGNORECASE),
    re.compile(r"output\s+must\s+be\s+(?:a\s+)?JSON\s+array", re.IGNORECASE),
    re.compile(r"###\s*Task:\s*(?:Suggest|Generate)\s+", re.IGNORECASE),
]

DEFAULT_LANGUAGE = "python"
INFER_LANGUAGE = "infer"  # No language detected; let Supervisor infer from prompt (avoids python injection)
# When no language mentioned: let Supervisor infer from prompt (markdown for plans/documents, else best guess)
TARGET_LANGUAGE_INFER = "infer"


def _language_explicitly_mentioned(text: str) -> bool:
    """True if user explicitly mentioned a programming language. Used to avoid defaulting to python."""
    if not text or not text.strip():
        return False
    t = text.strip()[:800]
    return any(pat.search(t) for pat, _ in _LANGUAGE_PATTERNS)


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
    """Best-effort language from user request. Returns INFER_LANGUAGE when no match (Supervisor infers from prompt)."""
    if not text or not text.strip():
        return INFER_LANGUAGE
    t = text.strip()[:800]
    for pat, lang in _LANGUAGE_PATTERNS:
        if pat.search(t):
            return lang
    return INFER_LANGUAGE


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

    # Pending continue: user replying to clarification/plan — analyze original task + reply so "4 week
    # training plan" inherits domain from "marathon plan" (athletics_running → output_type=document)
    text_to_analyze = last_content
    if state.get("pending_question_continue") and state.get("task_description"):
        orig = (state.get("task_description") or "").strip()[:500]
        if orig:
            text_to_analyze = f"{orig} {last_content or ''}".strip()[:800]

    message_origin = _classify_message_origin(last_content)
    policy = get_defaults_policy()

    # ScoringEngine from YAML (entry_classifier_weights.yaml)
    config_path = _weights_path()
    engine = get_scoring_engine(config_path)
    analysis = engine.analyze(text_to_analyze)

    task_size: TaskSize = analysis["task_size"]
    manual_override = analysis.get("manual_override", False)
    force_pro_advanced = analysis.get("force_pro_advanced", False)

    # Bypass Supervisor for trivial; else Supervisor runs. Force manual overrides.
    bypass_supervisor = task_size == "trivial" and not manual_override
    bypass_planner = task_size == "trivial" and not manual_override
    requires_clarification = task_size == "complex"

    # plan_required: Architect (complex) tasks; also when user explicitly requests planning (@plan, /plan, "lets plan")
    planning_session_requested = manual_override or force_pro_advanced
    if manual_override or task_size == "complex" or force_pro_advanced:
        plan_required = True
    else:
        plan_required = False

    # clarification_budget
    clarification_budget = 0 if task_size == "trivial" else (1 if task_size == "small" else 2)
    # Teach mode: must not increase interrogation (Phase 4 item 8)
    interaction_mode = analysis.get("interaction_mode", "do")
    if interaction_mode == "teach":
        clarification_budget = min(clarification_budget, 1)

    # worker_persona: Minimalist | Senior | Architect. worker_prompt_tier kept for backward compat.
    worker_persona: WorkerPersona = _TASK_SIZE_TO_PERSONA.get(task_size, "Senior")
    if force_pro_advanced or task_size == "complex":
        worker_persona = "Architect"
        worker_prompt_tier = "full"
    elif task_size == "trivial":
        worker_prompt_tier = "trivial"
    else:
        worker_prompt_tier = "small"

    # escalation_reason: set whenever routing to Supervisor (Phase 4 item 9)
    escalation_reason = ""
    reasons = analysis.get("classification_reasons") or []
    if not bypass_supervisor:
        if manual_override:
            escalation_reason = "manual_override"
        elif any("risk_veto" in r for r in reasons):
            escalation_reason = "risk_veto"
        elif any("length_veto" in r for r in reasons):
            escalation_reason = "length_veto"
        elif task_size == "complex":
            escalation_reason = "task_size_complex"
        else:
            escalation_reason = "task_size_small"

    # task_description: when pending continue, include original for downstream (Worker needs full context)
    if state.get("pending_question_continue") and state.get("task_description"):
        orig = (state.get("task_description") or "").strip()[:600]
        task_description = (
            f"{orig} {last_content or ''}".strip()[:1000] if orig else (last_content or "").strip()[:1000]
        )
    else:
        task_description = (last_content or "").strip()[:1000] if last_content else ""

    out: dict[str, Any] = {
        "message_origin": message_origin,
        "task_size": task_size,
        "worker_persona": worker_persona,
        "task_description": task_description,
        "target_language": "",  # set below from output_type and language detection
        "bypass_supervisor": bypass_supervisor,
        "bypass_planner": bypass_planner,
        "requires_clarification": requires_clarification,
        "plan_required": plan_required,
        "planning_session_requested": planning_session_requested,  # @plan, /plan, "lets plan" → show plan, ask to proceed
        "clarification_budget": clarification_budget,
        "interaction_mode": interaction_mode,
        "intent_classifier_source": "deterministic",
        "worker_prompt_tier": worker_prompt_tier,
        "escalation_reason": escalation_reason,
    }
    # Sovereign intersection: deterministic domains from EntryClassifier seed active_domain_refs
    active_domains = analysis.get("active_domains") or []
    if active_domains:
        out["active_domain_refs"] = active_domains

    out["intent_class"] = analysis.get("intent_class", "code")
    out["output_type"] = analysis.get("output_type", "code")  # document → explain_only; taxonomy-driven

    # Defensive: knowledge-style questions (what is, how does, explain) must never get code path
    _knowledge_style = re.compile(
        r"^(what is|what are|how much|how many|when did|who was|who is|"
        r"explain |define |describe |tell me about|why does|why do |how does |how do )",
        re.IGNORECASE,
    )
    if _knowledge_style.match((last_content or "").strip()):
        out["output_type"] = "document"
        out["intent_class"] = "knowledge"
        out["target_language"] = "markdown"
        logger.info(
            "entry_classifier_knowledge_override",
            extra={
                "intent_class": "knowledge",
                "output_type": "document",
                "preview": (last_content or "")[:60],
            },
        )
    # target_language: document→markdown; explicit lang→use it; else infer (Supervisor infers from prompt)
    # Use out["output_type"] so knowledge_override is respected
    eff_output_type = out.get("output_type", "code")
    if eff_output_type == "document":
        out["target_language"] = "markdown"
    elif _language_explicitly_mentioned(last_content):
        out["target_language"] = _detect_language(last_content)
    else:
        out["target_language"] = TARGET_LANGUAGE_INFER
    # Phase 1: explainability — classification_reasons and score_breakdown for /why
    out["classification_reasons"] = analysis.get("classification_reasons") or []
    out["score_breakdown"] = analysis.get("score_breakdown") or {}
    out["classification_score"] = analysis.get("score", 0)
    # Phase 2: split axes — complexity/risk/domain (domain never escalates)
    out["complexity_score"] = analysis.get("complexity_score", 0)
    out["risk_score"] = analysis.get("risk_score", 0)
    out["domain_hints"] = analysis.get("domain_hints") or []
    out["current_node"] = "entry_classifier"

    # task_size_override: /reclassify small|complex forces override (log for tuning)
    task_size_override = state.get("task_size_override")
    if task_size_override in ("trivial", "small", "complex"):
        task_size = task_size_override  # type: ignore[assignment]
        out["task_size"] = task_size
        out["reclassify_override"] = task_size_override
        # Recompute downstream fields for overridden task_size
        bypass_supervisor = task_size == "trivial"
        bypass_planner = task_size == "trivial"
        requires_clarification = task_size == "complex"
        plan_required = bool(manual_override or task_size == "complex" or force_pro_advanced)
        clarification_budget = 0 if task_size == "trivial" else (1 if task_size == "small" else 2)
        if interaction_mode == "teach":
            clarification_budget = min(clarification_budget, 1)
        worker_persona = _TASK_SIZE_TO_PERSONA.get(task_size, "Senior")
        worker_prompt_tier = "trivial" if task_size == "trivial" else ("small" if task_size == "small" else "full")
        out["bypass_supervisor"] = bypass_supervisor
        out["bypass_planner"] = bypass_planner
        out["requires_clarification"] = requires_clarification
        out["plan_required"] = plan_required
        out["clarification_budget"] = clarification_budget
        out["worker_persona"] = worker_persona
        out["worker_prompt_tier"] = worker_prompt_tier
        out["escalation_reason"] = "reclassify_override" if task_size != "trivial" else ""

    # Coding client (Cursor, Claude Code): ambiguous/general → allow code bias
    # Never override knowledge-style questions (what is, how does) to code
    if (
        state.get("coding_client_detected")
        and out.get("intent_class") != "knowledge"
        and analysis.get("intent_class") == "general"
        and analysis.get("output_type") == "document"
    ):
        out["output_type"] = "code"
        out["intent_class"] = "code"

    # Taxonomy-Driven Contextual Injection: resolve taxonomy_metadata from active_domain_refs + task_size
    taxonomy_metadata = resolve_taxonomy_metadata(
        active_domain_refs=out.get("active_domain_refs") or [],
        task_size=out.get("task_size", "small"),
        intent_class=out.get("intent_class", "code"),
        complexity_score=out.get("complexity_score", 0.5) or 0.5,
    )
    out["taxonomy_metadata"] = taxonomy_metadata

    # Taxonomy-driven: output_type=document → usually skip Planner; BUT high-depth domains (physics, etc.) or explicit planning session
    if out.get("output_type") == "document":
        deep_dive = should_plan_for_document(taxonomy_metadata, out.get("active_domain_refs") or [])
        if deep_dive or planning_session_requested:
            out["plan_required"] = True  # Route to Planner for required_elements or @plan/lets plan
            out["rag_mode"] = "normal" if deep_dive else "disabled"
        else:
            out["plan_required"] = False
            out["rag_mode"] = "disabled"
        # Clear stale execution_plan when not resuming pending — avoid injecting wrong plan steps (e.g. marathon)
        if not state.get("pending_question_continue") and not out.get("plan_required"):
            out["execution_plan"] = {}
    # Pending continue: preserve output_type=document from restored state
    elif state.get("pending_question_continue") and state.get("output_type") == "document":
        out["output_type"] = "document"
        out["plan_required"] = False
        out["rag_mode"] = "disabled"

    # Trivial fast-path: branch on output_type. Document → explain_only; code → single_file + sandbox.
    if task_size == "trivial" and not manual_override:
        out["task_is_trivial"] = True
        out["rag_mode"] = "disabled"
        out["task_description"] = (last_content or "").strip()[:500]
        if out.get("output_type") == "document":
            out["deliverable_type"] = "explain_only"
            out["task_type"] = "general"
            out["allowed_tools"] = ["none"]
        else:
            eff_lang = out["target_language"] if out["target_language"] not in ("", "infer") else DEFAULT_LANGUAGE
            out["touched_files"] = _trivial_touched_files(last_content, eff_lang)
            out["defaults_used"] = policy.get_defaults_used(eff_lang)
            out["deliverable_type"] = "single_file"
            out["include_tests"] = _trivial_wants_tests(last_content)
            out["include_run_commands"] = True
            out["task_type"] = "code_generation"
            out["allowed_tools"] = ["sandbox"]
        if out.get("interaction_mode") != "teach":
            out["interaction_mode"] = "do"

    # Diagnostic: trace taxonomy decisions for debugging document vs code path
    logger.info(
        "entry_classifier_result",
        extra={
            "intent_class": out.get("intent_class"),
            "output_type": out.get("output_type"),
            "deliverable_type": out.get("deliverable_type"),
            "task_size": out.get("task_size"),
            "target_language": out.get("target_language"),
            "preview": (last_content or "")[:80],
        },
    )
    return out
