"""Writer node — single-author response from plan outline + evidence packets.

Produces the full user-facing response in one coherent LLM pass. Streaming
is enabled so tokens flow to the user via SSE as they're generated.

This replaces the previous parallel section_worker + merge + compiler
pipeline with a single coordinated write that avoids repetition,
maintains natural cross-section coherence, and can make cross-cutting
decisions (e.g. choosing one approach across all sections).
"""

from __future__ import annotations

import logging
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..config import settings
from ..contract_validator import fingerprint_draft
from ..llm_telemetry import get_llm_http_client
from ..state import NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.writer")

_WRITER_SYSTEM_TEMPLATE = """\
You are the {persona}. You produce a complete, polished markdown \
response from a plan outline and compiled evidence.
{cohesion_block}
CONTENT RULES:
1. Answer the main question FIRST in the opening paragraph.
2. Follow the plan outline — each step becomes a section.
3. COMMIT to one recommended approach per decision point. Present the \
   chosen approach with reasoning; mention rejected alternatives only \
   to explain why the chosen path wins.
4. Do NOT present a menu of options without a clear recommendation. \
   If evidence is insufficient to choose, say so explicitly and state \
   what information would resolve it.
5. Prefer concrete tool/library/pattern names over abstract categories.
6. Weave evidence naturally into prose. Cite sources inline when a \
   claim relies on evidence: [Source: doc_name — URL].
7. Label assumptions inline with [Assumption] when materially relevant.
8. Qualify unsupported claims with "roughly" / "approximately" or omit.
9. Every paragraph must earn its space. Cut filler, generic scaffolding, \
   and hedge phrases like "it depends on your use case".
10. Do NOT invent information not present in the evidence or your \
    training knowledge. When uncertain, say so.

FORMATTING — pick the right element for the content:
- TABLE (pipe syntax with header row) when comparing options, models, \
  tools, or alternatives side-by-side.
- NUMBERED LIST when describing ordered steps or a procedure.
- BULLET LIST when listing features, properties, or unordered items.
- CODE BLOCK (```lang) when showing commands, config, or file paths.
- DIAGRAM (```mermaid) when visualizing architecture, data flow, \
  sequences, or component relationships. Diagrams are valuable.
- PROSE when explaining reasoning, tradeoffs, or narrative analysis.
- Use inline `backticks` for tool, command, and model names.
- Do NOT bold keywords just to signal coverage.

HEADING STYLE:
- Use a descriptive top-level heading (# Title) that names the topic.
- Section headings should read as a table of contents for an expert \
  document — NOT echoes of the user's imperative phrasing.
  Bad: "Explain How Retrieval Should Work".
  Good: "Retrieval Architecture".
- Do NOT use "Deep Dive" as a heading.

CONSTRAINT AWARENESS:
- Proposals MUST fit within stated hard constraints (timeline, budget, \
  team size). If a component would exceed them, either simplify or \
  explicitly justify why the constraint should be relaxed.
- Prefer simpler architectures that deliver within the timeline over \
  theoretically superior designs that require more time or resources.

CITATION:
- When evidence is provided and a claim relies on it, cite inline: \
  [Source: doc_name — URL].
- You MUST only cite URLs from the AVAILABLE SOURCES list injected below \
  the evidence. Do NOT invent, shorten, or guess URLs. If no AVAILABLE \
  SOURCES list is present, do NOT produce inline URL citations.
- At the end, add a "## Sources" section listing cited sources.
- If no claims reference specific sources, omit the Sources section.

OUTPUT: Markdown with section headings. No JSON wrapper.
"""

_COHESION_BLOCK_TEMPLATE = """
GROUNDING CONSTRAINT — COHESION LOCK:
You MUST stay within the conceptual frame: {entity}.
{exclusions}Do not introduce information from outside this frame, even from your \
training data. If the lock is a specific entity, stay specific to that entity. \
If generic/theoretical, stay theoretical and do not mix in vendor-specific advice.
"""


def _resolve_persona(state: dict[str, Any]) -> str:
    """Resolve persona from state, falling back through sources."""
    user_task = state.get("user_task") or {}
    persona = user_task.get("persona", "")
    if persona:
        return persona

    taxonomy_meta = state.get("taxonomy_metadata") or {}
    persona = taxonomy_meta.get("persona_instructions", "")
    if persona:
        return persona

    return "Structured Writer"


def _build_cohesion_block(state: dict[str, Any]) -> str:
    """Build the cohesion lock grounding constraint block for the writer prompt."""
    lock = state.get("cohesion_lock") or {}
    entity = lock.get("entity", "")
    if not entity:
        return ""

    exclude_signals = lock.get("exclude_signals") or []
    exclusions = ""
    if exclude_signals:
        exclusions = "Specifically EXCLUDE content about: " + ", ".join(exclude_signals[:8]) + ".\n"

    return _COHESION_BLOCK_TEMPLATE.format(entity=entity, exclusions=exclusions)


def _build_system_prompt(state: dict[str, Any]) -> str:
    """Build the complete writer system prompt with persona and cohesion lock."""
    persona = _resolve_persona(state)
    cohesion_block = _build_cohesion_block(state)
    return _WRITER_SYSTEM_TEMPLATE.format(
        persona=persona,
        cohesion_block=cohesion_block,
    )


def _extract_top_snippets(
    snippets: list[Any],
    max_snippets: int = 3,
    min_relevance: float = 0.6,
) -> list[str]:
    """Extract highest-relevance snippet texts from an evidence packet."""
    scored: list[tuple[float, str]] = []
    for s in snippets or []:
        text = s.get("text", "") if isinstance(s, dict) else getattr(s, "text", "")
        rel = s.get("relevance", 0) if isinstance(s, dict) else getattr(s, "relevance", 0)
        text = (text or "").strip()
        if text and float(rel or 0) >= min_relevance:
            scored.append((float(rel), text))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [t for _, t in scored[:max_snippets]]


def _long_context_reorder(items: list[str]) -> list[str]:
    """Lost-in-the-middle mitigation: place strongest items at context edges.

    LLMs attend more to the beginning and end of long context windows.
    This interleaves items so the highest-ranked appear at positions 1
    and N, with lower-ranked items in the middle.

    Research: Liu et al. 2024, "Lost in the Middle: How Language Models
    Use Long Contexts" — performance degrades for information placed in
    the middle of the input context.
    """
    if len(items) <= 2:
        return items
    reordered: list[str] = []
    for i, item in enumerate(items):
        if i % 2 == 0:
            reordered.append(item)
        else:
            reordered.insert(len(reordered) // 2, item)
    return reordered


_DECISIVE_BLOCK = """\

DECISIVENESS (user explicitly requested committed recommendations):
- Pick ONE tool, library, or approach per decision point. Name it.
- Mention rejected alternatives only briefly to explain why the chosen \
  option wins.
- Do NOT present a menu of options without a clear recommendation. \
  Saying "X or Y" without picking one is not acceptable.
- If the evidence is insufficient to choose, say what information \
  would resolve it rather than listing options.
- Match architectural complexity to the stated timeline — fewer moving \
  parts that ship on time beats a perfect design that takes 2x longer.
"""


def _build_task_block(state: dict[str, Any]) -> str:
    """Build user_task context block for the writer prompt."""
    frame = state.get("user_task") or {}
    if not frame:
        return ""

    parts: list[str] = []

    main_q = frame.get("main_question", "")
    if main_q:
        parts.append(f"Main question: {main_q}")

    requirements = frame.get("explicit_requirements") or []
    if requirements:
        parts.append("Requirements: " + "; ".join(requirements[:10]))

    # Hard constraints get their own block for emphasis
    constraints = frame.get("constraints") or []
    negative = frame.get("negative_constraints") or []

    hard_constraints: list[str] = []
    soft_constraints: list[str] = []
    for c in constraints:
        cl = c.lower()
        if any(
            kw in cl
            for kw in ("day", "month", "week", "budget", "limited", "team size", "engineer", "timeline", "deadline")
        ):
            hard_constraints.append(c)
        else:
            soft_constraints.append(c)

    if hard_constraints:
        parts.append(
            "HARD CONSTRAINTS (non-negotiable — proposals must fit within these): " + "; ".join(hard_constraints)
        )
    if soft_constraints:
        parts.append("Constraints: " + "; ".join(soft_constraints[:6]))
    if negative:
        parts.append("Do NOT: " + "; ".join(negative[:6]))

    deliverables = frame.get("deliverables") or []
    if deliverables:
        parts.append("Required deliverables: " + "; ".join(deliverables[:10]))

    success = frame.get("success_criteria") or []
    if success:
        parts.append("Success criteria: " + "; ".join(success[:6]))

    output_format = frame.get("requested_format", "")
    if output_format and output_format != "prose":
        parts.append(f"Output format: {output_format}")

    if not parts:
        return ""

    return "## User Task\n" + "\n".join(f"- {p}" for p in parts) + "\n"


def _build_outline_block(state: dict[str, Any]) -> str:
    """Build the plan outline block for the writer."""
    plan = state.get("execution_plan") or {}
    steps = plan.get("steps", [])
    if not steps:
        return ""

    lines = []
    for s in steps:
        action = s.get("action", str(s)) if isinstance(s, dict) else str(s)
        lines.append(f"- {action}")

    return "## Document Outline\n" + "\n".join(lines) + "\n"


def _build_sources_section(state: dict[str, Any]) -> str:
    """Build a ## Sources section from evidence packet provenance."""
    packets = state.get("evidence_packets") or []
    if not packets:
        return ""

    seen: set[str] = set()
    lines: list[str] = []
    idx = 0
    for p in packets:
        sources = p.get("sources", []) if isinstance(p, dict) else getattr(p, "sources", [])
        for s in sources:
            uri = s.get("uri", "") if isinstance(s, dict) else getattr(s, "uri", "")
            metadata = s.get("metadata", {}) if isinstance(s, dict) else getattr(s, "metadata", {})
            authority = metadata.get("authority", "")
            doc_name = metadata.get("document_name", "")

            key = uri.lower()
            if not key or key in seen:
                continue
            seen.add(key)
            idx += 1

            badge = f" [{authority.title()}]" if authority else ""
            display = doc_name or uri
            url_part = f" — {uri}" if uri.startswith("http") else ""
            lines.append(f"[{idx}] {display}{url_part}{badge}")

    if not lines:
        return ""
    return "## Sources\n\n" + "\n".join(lines)


def _build_available_sources(packets: list[dict[str, Any] | Any]) -> str:
    """Extract deduplicated (doc_name, uri) pairs from evidence packets."""
    seen: set[str] = set()
    lines: list[str] = []
    for p in packets:
        sources = p.get("sources", []) if isinstance(p, dict) else getattr(p, "sources", [])
        for s in sources:
            uri = s.get("uri", "") if isinstance(s, dict) else getattr(s, "uri", "")
            if not uri or not uri.startswith("http") or uri in seen:
                continue
            seen.add(uri)
            meta = s.get("metadata", {}) if isinstance(s, dict) else getattr(s, "metadata", {})
            doc_name = ""
            if isinstance(meta, dict):
                doc_name = meta.get("document", "") or meta.get("document_name", "")
            display = f"{doc_name} — {uri}" if doc_name else uri
            lines.append(f"- {display}")
    if not lines:
        return ""
    return "## AVAILABLE SOURCES (cite ONLY these URLs)\n" + "\n".join(lines) + "\n"


async def writer_node(state: dict[str, Any]) -> dict[str, Any]:
    """Produce the full response from plan outline + evidence packets."""
    start = time.monotonic()
    node_name = "writer"

    # Build evidence from Router's evidence packets (summaries + top snippets).
    # Sort by confidence descending so _long_context_reorder places the
    # highest-confidence evidence at the attention zones (beginning + end).
    packets = state.get("evidence_packets") or []
    packets = sorted(
        packets,
        key=lambda p: float(
            p.get("confidence", 0) if isinstance(p, dict) else getattr(p, "confidence", 0)
        ),
        reverse=True,
    )
    evidence_parts: list[str] = []
    for p in packets:
        summary = p.get("summary", "") if isinstance(p, dict) else getattr(p, "summary", "")
        if not summary:
            continue

        snippets = p.get("snippets", []) if isinstance(p, dict) else getattr(p, "snippets", [])
        top_snippets = _extract_top_snippets(snippets, max_snippets=3, min_relevance=0.6)
        if top_snippets:
            snippet_block = "\n".join(f"  > {s}" for s in top_snippets)
            evidence_parts.append(f"{summary}\n\nKey excerpts:\n{snippet_block}")
        else:
            evidence_parts.append(summary)

    # Lost-in-the-middle mitigation: reorder evidence so strongest items
    # appear at the start and end of the context window.
    if settings.long_context_reorder_enabled and len(evidence_parts) > 2:
        evidence_parts = _long_context_reorder(evidence_parts)

    compiled_evidence = "\n---\n".join(evidence_parts)

    if len(compiled_evidence) > settings.evidence_budget_chars:
        compiled_evidence = compiled_evidence[: settings.evidence_budget_chars]

    task_block = _build_task_block(state)
    outline_block = _build_outline_block(state)

    style_contract = state.get("style_contract_locked") or {}
    verbosity = style_contract.get("verbosity_target", "moderate")

    difficulty = state.get("difficulty", 0.5)
    writer_budget = settings.scaled_writer_budget(difficulty)
    writer_budget = max(2048, min(writer_budget, 12288))

    writer_url = settings.writer_model_url or settings.general_model_url
    writer_name = settings.writer_model_name or settings.general_model_name

    decisive = style_contract.get("decisive", False)

    # Build system prompt with dynamic persona and cohesion lock
    system_prompt = _build_system_prompt(state)

    # Taxonomy-driven depth + output style injection (additive to template)
    taxonomy_meta = state.get("taxonomy_metadata") or {}
    if taxonomy_meta:
        from ..taxonomy_prompt_factory import get_output_style_guidance

        complexity = float(taxonomy_meta.get("complexity_score", 0))
        depth_instr = (taxonomy_meta.get("depth_instructions") or "").strip()
        style_guidance = get_output_style_guidance(taxonomy_meta)

        if complexity > 0.55 and depth_instr:
            system_prompt += f"\n\nDOMAIN DEPTH:\n{depth_instr}"
        if style_guidance:
            system_prompt += f"\n\nOUTPUT STYLE:\n{style_guidance}"

        epistemic = (taxonomy_meta.get("epistemic_guidance") or "").strip()
        if epistemic:
            system_prompt += f"\n\nEPISTEMIC DISCIPLINE:\n{epistemic}"

    user_msg = f"{task_block}\n{outline_block}\nTarget verbosity: {verbosity}\n\n"

    if decisive:
        user_msg += _DECISIVE_BLOCK + "\n"

    if compiled_evidence:
        user_msg += f'## Evidence\n<context trust="untrusted">\n{compiled_evidence}\n</context>\n'

    available_sources = _build_available_sources(packets)
    if available_sources:
        user_msg += f"\n{available_sources}\n"

    # Token budget: estimate input, ensure output fits
    model_context = settings.compiler_model_context
    estimated_input_tokens = (len(system_prompt) + len(user_msg)) // 4
    available_output = model_context - estimated_input_tokens - 256

    if writer_budget > available_output:
        logger.info(
            "writer_budget_clamped",
            extra={
                "requested": writer_budget,
                "available": available_output,
                "input_estimate": estimated_input_tokens,
                "model_context": model_context,
            },
        )
        writer_budget = max(2048, available_output)

    logger.info(
        "writer_start",
        extra={
            "evidence_len": len(compiled_evidence),
            "task_block_len": len(task_block),
            "outline_len": len(outline_block),
            "writer_budget": writer_budget,
            "input_estimate": estimated_input_tokens,
            "difficulty": round(difficulty, 2),
        },
    )

    try:
        llm = ChatOpenAI(
            base_url=writer_url,
            api_key="not-needed",
            model=writer_name,
            temperature=0.3,
            max_completion_tokens=writer_budget,
            streaming=True,
            use_responses_api=False,
            model_kwargs={"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}},
            http_client=get_llm_http_client(),
        )

        result = await llm.ainvoke(
            [
                SystemMessage(content=system_prompt),
                HumanMessage(content=user_msg),
            ]
        )

        compiled = (result.content or "").strip()
        if not compiled or len(compiled) < 50:
            logger.warning("writer_output_too_short")
            compiled = "*Response generation produced insufficient output.*"

        # Append provenance-based Sources section if writer didn't include one
        if "## Sources" not in compiled:
            sources_section = _build_sources_section(state)
            if sources_section:
                compiled = compiled.rstrip() + "\n\n" + sources_section

        latency = (time.monotonic() - start) * 1000
        available_sources_count = (
            len([l for l in available_sources.splitlines() if l.strip().startswith("-")]) if available_sources else 0
        )
        sections_written = sum(
            1 for line in compiled.split("\n") if line.strip().startswith("## ") and not line.strip().startswith("### ")
        )
        logger.info(
            "writer_complete",
            extra={
                "output_len": len(compiled),
                "evidence_len": len(compiled_evidence),
                "latency_ms": round(latency),
                "writer_budget": writer_budget,
                "available_sources_count": available_sources_count,
                "sections_written": sections_written,
            },
        )

        return {
            "generated_code": compiled,
            "compiled_answer": compiled,
            "draft_fingerprints": [fingerprint_draft(compiled)],
            "error": None,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"Wrote {len(compiled)} chars from {len(compiled_evidence)} chars of evidence",
                    confidence=0.85,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=latency,
                )
            ],
        }

    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.warning("writer_failed", exc_info=True)
        fallback = f"*Response generation failed: {e!s}*"
        return {
            "generated_code": fallback,
            "compiled_answer": fallback,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"Writer failed: {e}",
                    confidence=0.0,
                    outcome=NodeOutcome.ERROR,
                    latency_ms=latency,
                )
            ],
        }
