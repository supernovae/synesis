"""Deterministic contract validators for the anti-oscillation framework.

Six validators enforce monotonic revision rules by checking state contracts
before and after node execution. No LLM calls — pure function checks.

Wired into graph.py via the ``validated_node`` wrapper.
"""

from __future__ import annotations

import hashlib
import logging
import re
from collections.abc import Callable
from functools import wraps
from typing import Any

logger = logging.getLogger("synesis.contract_validator")

ValidationResult = tuple[bool, list[str]]


# ---------------------------------------------------------------------------
# 1. Required sections
# ---------------------------------------------------------------------------


_STOPWORDS = frozenset(
    [
        "a",
        "an",
        "the",
        "and",
        "or",
        "of",
        "in",
        "on",
        "for",
        "to",
        "is",
        "are",
        "was",
        "be",
        "by",
        "at",
        "from",
        "with",
        "as",
        "it",
        "this",
        "that",
        "these",
        "those",
        "how",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "do",
        "does",
        "did",
        "should",
        "would",
        "could",
        "can",
        "may",
        "might",
        "shall",
        "will",
        "must",
        "give",
        "list",
        "state",
        "explain",
        "describe",
        "propose",
        "provide",
        "detail",
        "cover",
        "specify",
        "discuss",
        "outline",
    ]
)


def _extract_keywords(text: str) -> set[str]:
    """Extract meaningful content words from a deliverable string."""
    words = re.findall(r"[a-z]+", text.lower())
    return {w for w in words if w not in _STOPWORDS and len(w) > 2}


def validate_required_sections(state: dict[str, Any]) -> ValidationResult:
    """Every user_task.deliverables item must be covered in the draft.

    Uses keyword overlap rather than exact substring matching so that
    rephrased headings still satisfy the deliverable requirement.
    """
    frame = state.get("user_task") or {}
    deliverables = frame.get("deliverables") or []
    if not deliverables:
        return True, []

    draft = state.get("generated_code", "")
    section_results = state.get("section_results") or []

    search_text = draft.lower()
    if section_results:
        search_text += " " + " ".join(
            (s.get("text", "") or s.get("section_action", "")).lower() for s in section_results
        )

    violations: list[str] = []
    for deliverable in deliverables:
        needle = deliverable.lower().strip()
        if not needle:
            continue
        # Fast path: exact substring match
        if needle in search_text:
            continue
        # Medium path: heading match
        if _heading_present(needle, search_text):
            continue
        # Fuzzy path: require ≥60% keyword overlap
        kw = _extract_keywords(needle)
        if kw:
            hits = sum(1 for w in kw if w in search_text)
            if hits / len(kw) >= 0.6:
                continue
        violations.append(f"missing_section: {deliverable}")

    return (len(violations) == 0), violations


def _heading_present(needle: str, text: str) -> bool:
    """Check if a deliverable's key terms appear as a markdown heading."""
    kw = _extract_keywords(needle)
    if not kw:
        return False
    # Check if any heading contains at least half of the keywords
    for m in re.finditer(r"^#{1,4}\s+(.+)$", text, re.MULTILINE):
        heading_text = m.group(1).lower()
        hits = sum(1 for w in kw if w in heading_text)
        if hits >= max(1, len(kw) * 0.5):
            return True
    return False


# ---------------------------------------------------------------------------
# 2. Style compliance
# ---------------------------------------------------------------------------


def validate_style_compliance(state: dict[str, Any]) -> ValidationResult:
    """Check draft against style_contract_locked constraints."""
    contract = state.get("style_contract_locked") or {}
    if not contract:
        return True, []

    draft = state.get("generated_code", "")
    if not draft:
        return True, []

    violations: list[str] = []

    if contract.get("direct_answer_first", True):
        first_para = draft.strip().split("\n\n")[0] if draft.strip() else ""
        preamble_markers = ("before we begin", "let me start by", "first, let's", "in this response")
        if any(m in first_para.lower() for m in preamble_markers):
            violations.append("style: direct_answer_first violated — response starts with preamble")

    return (len(violations) == 0), violations


# ---------------------------------------------------------------------------
# 3. Decision drift
# ---------------------------------------------------------------------------


def validate_decision_drift(state: dict[str, Any]) -> ValidationResult:
    """Flag when draft introduces tools/stacks/approaches not in the decision ledger."""
    ledger = state.get("decision_ledger") or []
    if not ledger:
        return True, []

    draft = (state.get("generated_code") or "").lower()
    if not draft:
        return True, []

    override_log = state.get("override_log") or []
    approved_overrides = {o.get("target_decision_id") for o in override_log if o.get("approved")}

    violations: list[str] = []
    for entry in ledger:
        if not entry.get("frozen", True):
            continue
        decision_id = entry.get("decision_id", "")
        if decision_id in approved_overrides:
            continue

        chosen = (entry.get("chosen") or "").lower().strip()
        rejected = [r.lower().strip() for r in (entry.get("rejected_alternatives") or []) if r]

        if not chosen or not rejected:
            continue

        for alt in rejected:
            if not alt or len(alt) < 3:
                continue
            if alt in draft and chosen not in draft:
                violations.append(
                    f"decision_drift: ledger chose '{entry.get('chosen')}' but draft uses "
                    f"rejected alternative '{alt}' (decision_id={decision_id})"
                )

    return (len(violations) == 0), violations


# ---------------------------------------------------------------------------
# 4. Critique resolutions
# ---------------------------------------------------------------------------


def validate_critique_resolutions(state: dict[str, Any]) -> ValidationResult:
    """All open critique items from previous iteration must be resolved."""
    register = state.get("critique_register") or {}
    if not register:
        return True, []

    violations: list[str] = []
    for item_id, item in register.items():
        if not isinstance(item, dict):
            continue
        if item.get("status") == "open":
            violations.append(f"unresolved_critique: {item_id} — {item.get('description', '')[:80]}")

    return (len(violations) == 0), violations


# ---------------------------------------------------------------------------
# 5. Citation preservation
# ---------------------------------------------------------------------------


def validate_citation_preservation(state: dict[str, Any]) -> ValidationResult:
    """Flag citations that were dropped between draft revisions."""
    fingerprints = state.get("draft_fingerprints") or []
    if len(fingerprints) < 2:
        return True, []

    source_urls = state.get("rag_source_urls") or []
    doc_names = state.get("rag_document_names") or []
    if not source_urls and not doc_names:
        return True, []

    draft = (state.get("generated_code") or "").lower()
    if not draft:
        return True, []

    violations: list[str] = []

    all_citations = set()
    for url in source_urls:
        if url and url.strip():
            all_citations.add(url.strip().lower())
    for name in doc_names:
        if name and name.strip():
            all_citations.add(name.strip().lower())

    for citation in all_citations:
        if len(citation) < 4:
            continue
        if citation not in draft:
            violations.append(f"citation_dropped: {citation[:60]}")

    return (len(violations) == 0), violations


# ---------------------------------------------------------------------------
# 6. Role-source match
# ---------------------------------------------------------------------------


def validate_role_source_match(state: dict[str, Any], role: str = "") -> ValidationResult:
    """No-op: role-source matching removed (Router owns all retrieval)."""
    return True, []


# ---------------------------------------------------------------------------
# Draft fingerprinting utility
# ---------------------------------------------------------------------------


def fingerprint_draft(draft: str) -> str:
    """Produce a compact blake2b hash of the draft content."""
    return hashlib.blake2b(draft.encode(), digest_size=16).hexdigest()


# ---------------------------------------------------------------------------
# validated_node wrapper
# ---------------------------------------------------------------------------


def _inject_violation_context(state: dict[str, Any], violations: list[str]) -> dict[str, Any]:
    """Add detected violations to state so the node can see them in context."""
    existing = list(state.get("_validation_warnings") or [])
    existing.extend(violations)
    return {**state, "_validation_warnings": existing}


def _annotate_violations(result: dict[str, Any], violations: list[str]) -> dict[str, Any]:
    """Append post-node violations to critique_register as open items."""
    register = dict(result.get("critique_register") or {})
    for v in violations:
        item_id = f"validator_{hashlib.blake2b(v.encode(), digest_size=8).hexdigest()}"
        register[item_id] = {
            "item_id": item_id,
            "category": v.split(":")[0] if ":" in v else "validation",
            "description": v,
            "status": "open",
            "evidence_ref": "deterministic_validator",
            "resolved_by": "",
            "reopen_count": 0,
        }
    result["critique_register"] = register

    for v in violations:
        logger.warning("post_node_violation: %s", v)

    return result


def validated_node(
    node_fn: Callable,
    validators_before: list[Callable] | None = None,
    validators_after: list[Callable] | None = None,
) -> Callable:
    """Wrap a node function with pre/post deterministic validation."""

    @wraps(node_fn)
    async def wrapper(state: dict[str, Any]) -> dict[str, Any]:
        for v in validators_before or []:
            passed, violations = v(state)
            if not passed:
                state = _inject_violation_context(state, violations)

        result = await node_fn(state)

        merged = {**state, **result}
        for v in validators_after or []:
            passed, violations = v(merged)
            if not passed:
                result = _annotate_violations(result, violations)

        return result

    return wrapper
