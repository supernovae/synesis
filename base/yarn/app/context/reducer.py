"""Reduce optional structured client context into one cache-friendly user string.

Ordering goals for prefix caching:
- Fixed outer tags and section headers first (identical every turn).
- Deterministic ordering inside optional sections (sorted keys / sorted evidence).
- Variable content only inside escaped bodies at the end of the composed string.
"""

from __future__ import annotations

import html
import json
from typing import Any

from .delimiters import (
    SYNESIS_CODER_TURN_CLOSE,
    SYNESIS_CODER_TURN_OPEN,
    SYNESIS_EVIDENCE_CLOSE,
    SYNESIS_STRUCTURED_CLOSE,
    SYNESIS_STRUCTURED_OPEN,
    SYNESIS_USER_INTENT_CLOSE,
    SYNESIS_USER_INTENT_OPEN,
)
from .schemas import EvidenceObject, SynesisCoderContext


def escape_evidence_text(text: str) -> str:
    """Escape so delimiter tags inside client/tool text cannot break out."""
    return html.escape(text or "", quote=True)


def _sorted_evidence(items: list[EvidenceObject]) -> list[EvidenceObject]:
    return sorted(items, key=lambda e: (e.kind, e.label, e.body))


def _json_stable(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _context_has_payload(ctx: SynesisCoderContext) -> bool:
    return bool(
        ctx.task_pack is not None
        or ctx.taxonomy
        or ctx.trust_labels
        or ctx.evidence_objects
        or ctx.policy_requirements
        or ctx.validation_results is not None
        or ctx.open_questions
        or ctx.decision_trace is not None
    )


def build_user_turn_content(
    primary_user_text: str,
    synesis_context: SynesisCoderContext | None = None,
) -> str:
    """Compose the user message body: fixed envelope + primary intent + optional structured tail."""
    parts: list[str] = [SYNESIS_CODER_TURN_OPEN]

    parts.append(SYNESIS_USER_INTENT_OPEN)
    parts.append(escape_evidence_text(primary_user_text))
    parts.append(SYNESIS_USER_INTENT_CLOSE)

    if synesis_context is not None and _context_has_payload(synesis_context):
        parts.append(SYNESIS_STRUCTURED_OPEN)

        if synesis_context.task_pack is not None:
            parts.append("<synesis_field name=\"task_pack\">")
            parts.append(escape_evidence_text(_json_stable(synesis_context.task_pack)))
            parts.append("</synesis_field>")

        if synesis_context.taxonomy:
            parts.append("<synesis_field name=\"taxonomy\">")
            parts.append(escape_evidence_text(_json_stable(sorted(synesis_context.taxonomy))))
            parts.append("</synesis_field>")

        if synesis_context.trust_labels:
            parts.append("<synesis_field name=\"trust_labels\">")
            parts.append(escape_evidence_text(_json_stable(dict(sorted(synesis_context.trust_labels.items())))))
            parts.append("</synesis_field>")

        for ev in _sorted_evidence(list(synesis_context.evidence_objects)):
            parts.append(
                '<synesis_evidence kind="'
                + escape_evidence_text(ev.kind)
                + '" tier="'
                + escape_evidence_text(ev.tier)
                + '">'
            )
            if ev.label:
                parts.append(f'<synesis_label>{escape_evidence_text(ev.label)}</synesis_label>')
            parts.append(escape_evidence_text(ev.body))
            parts.append(SYNESIS_EVIDENCE_CLOSE)

        if synesis_context.policy_requirements:
            parts.append("<synesis_field name=\"policy_requirements\">")
            parts.append(escape_evidence_text(_json_stable(list(synesis_context.policy_requirements))))
            parts.append("</synesis_field>")

        if synesis_context.validation_results is not None:
            parts.append("<synesis_field name=\"validation_results\">")
            parts.append(escape_evidence_text(_json_stable(synesis_context.validation_results)))
            parts.append("</synesis_field>")

        if synesis_context.open_questions:
            parts.append("<synesis_field name=\"open_questions\">")
            parts.append(escape_evidence_text(_json_stable(list(synesis_context.open_questions))))
            parts.append("</synesis_field>")

        if synesis_context.decision_trace is not None:
            parts.append("<synesis_field name=\"decision_trace\">")
            parts.append(escape_evidence_text(_json_stable(synesis_context.decision_trace)))
            parts.append("</synesis_field>")

        parts.append(SYNESIS_STRUCTURED_CLOSE)

    parts.append(SYNESIS_CODER_TURN_CLOSE)
    return "".join(parts)


def wrap_tool_result_content(name: str, content: str) -> str:
    """Wrap tool output for the transcript (stable outer tags; name in opening line)."""
    from .delimiters import SYNESIS_TOOL_OUTPUT_CLOSE, SYNESIS_TOOL_OUTPUT_OPEN

    safe_name = html.escape(name or "unknown", quote=True)
    return (
        f"{SYNESIS_TOOL_OUTPUT_OPEN.format(name=safe_name)}"
        f"{escape_evidence_text(content)}"
        f"{SYNESIS_TOOL_OUTPUT_CLOSE}"
    )
