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
import re
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
3. COMMIT to one recommended approach per decision point. Pick ONE \
   tool, library, model, or pattern and name it. Present the chosen \
   approach with reasoning; mention rejected alternatives only to \
   explain why the chosen path wins. Never present "X or Y" without \
   choosing.
4. All decisions and quantitative claims MUST be internally consistent \
   across all sections. If you choose FAISS in one section, do not use \
   Pinecone in another. If you state "<500ms latency" early, do not \
   state "<1s" later. One number, one technology, one architecture.
5. If evidence is insufficient to choose, say so explicitly and state \
   what information would resolve it — do NOT fill the gap with a menu.
6. Prefer concrete tool/library/pattern names over abstract categories.
7. Weave evidence naturally into prose. Cite sources inline when a \
   claim relies on evidence: [Source: doc_name — URL].
8. Label assumptions inline with [Assumption] when materially relevant.
9. Qualify unsupported claims with "roughly" / "approximately" or omit.
10. Every paragraph must earn its space. Cut filler, generic scaffolding, \
    and hedge phrases like "it depends on your use case".
11. Do NOT invent information not present in the evidence or your \
    training knowledge. When uncertain, say so.
12. If a REVISION CONTEXT is provided below, PRESERVE all prior \
    decisions that were not explicitly flagged by the reviewer. Only \
    change what the reviewer asked you to change.

FORMATTING — pick the right element for the content:
- TABLE (pipe syntax with header row) when comparing options, models, \
  tools, or alternatives side-by-side.
- NUMBERED LIST when describing ordered steps or a procedure.
- BULLET LIST when listing features, properties, or unordered items.
- CODE BLOCK (```lang) when showing commands, config, or file paths.
- DIAGRAM (```mermaid) when visualizing architecture, data flow, \
  sequences, or component relationships. Diagrams are valuable.
  In mermaid nodes, ALWAYS quote labels containing parentheses or special \
  characters: A["Vector DB (FAISS)"] not A[Vector DB (FAISS)].
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
- Do NOT add a Sources section at the end — the system appends one \
  automatically from provenance metadata.

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


def _build_revision_context(state: dict[str, Any]) -> str:
    """Build revision instructions when the critic rejected a previous draft.

    Injects the critic's feedback, prioritized repair instructions, and a
    directive to preserve decisions that were NOT flagged, preventing
    architectural oscillation across revision cycles.
    """
    iteration = state.get("iteration_count", 0)
    if iteration < 1:
        return ""

    critic_feedback = (state.get("critic_feedback") or "").strip()
    previous_draft = (state.get("generated_code") or "").strip()

    if not critic_feedback and not previous_draft:
        return ""

    parts: list[str] = [
        f"\n## REVISION CONTEXT (iteration {iteration})",
        "A previous draft was reviewed and requires changes.",
    ]

    if critic_feedback:
        parts.append(f"REVIEWER FEEDBACK:\n{critic_feedback[:2000]}")

    # Prioritized repair instructions from the critic (concrete actions)
    repair_instructions = state.get("repair_instructions") or []
    if repair_instructions:
        sorted_repairs = sorted(repair_instructions, key=lambda r: r.get("priority", 99))
        repair_lines = []
        for r in sorted_repairs[:8]:
            target = r.get("target", "")
            action = r.get("action", "")
            reason = r.get("reason", "")
            line = f"  {r.get('priority', '?')}. [{target}] {action}"
            if reason:
                line += f" — {reason[:150]}"
            repair_lines.append(line)
        parts.append("REPAIR ACTIONS (prioritized — address in this order):\n" + "\n".join(repair_lines))

    # Requirement coverage gaps from the critic
    requirement_coverage = state.get("requirement_coverage") or []
    missed = [rc for rc in requirement_coverage if isinstance(rc, dict) and rc.get("status") in ("missed", "partial")]
    if missed:
        gap_lines = [f"  - [{rc.get('status', '?')}] {rc.get('requirement', '')}" for rc in missed[:6]]
        parts.append("REQUIREMENT GAPS (these must be addressed):\n" + "\n".join(gap_lines))

    parts.append(
        "REVISION RULES:\n"
        "1. Fix ONLY the issues the reviewer raised. Do not rewrite "
        "sections the reviewer did not mention.\n"
        "2. PRESERVE all technology choices, model names, cost/latency "
        "numbers, and architectural decisions from the previous draft "
        "unless the reviewer explicitly flagged them.\n"
        "3. Do NOT switch libraries, databases, models, or frameworks "
        "between revisions unless the reviewer requested it.\n"
        "4. Produce a SINGLE complete document — not an addendum or "
        "partial patch."
    )

    if previous_draft:
        _extract_decisions(previous_draft, parts)

    return "\n".join(parts) + "\n"


_PROSE_DECISION_RE = re.compile(
    r"(?:we (?:recommend|chose|use|selected|adopt)|"
    r"the (?:best|recommended|chosen) (?:choice|option|approach) is|"
    r"using \w+ (?:for|as|to)|"
    r"(?:deploy|run|host) (?:on|with|via))\s+",
    re.IGNORECASE,
)
_MERMAID_NODE_RE = re.compile(r'\w+\["([^"]+)"\]')


def _extract_decisions(draft: str, parts: list[str]) -> None:
    """Extract key decisions from previous draft for continuity.

    Scans table rows, quantitative claims, prose-form technology choices,
    and mermaid diagram node labels to build a settled-decisions summary
    the writer must preserve.
    """
    decisions: list[str] = []
    seen: set[str] = set()

    def _add(text: str) -> None:
        key = text.strip().lower()[:80]
        if key not in seen:
            seen.add(key)
            decisions.append(text.strip()[:200])

    for line in draft.split("\n"):
        stripped = line.strip()

        # Table rows (non-separator, non-header-divider)
        if stripped.startswith("|") and not stripped.startswith("|--") and not stripped.startswith("| -"):
            cells = [c.strip() for c in stripped.split("|") if c.strip()]
            if len(cells) >= 2 and not all(c.startswith("-") for c in cells):
                _add(" | ".join(cells[:3]))

    # Quantitative claims (latency, cost, timelines, SLAs)
    quant_pattern = re.compile(
        r"(?:latency|cost|budget|timeline|P\d{2}|SL[AIO]|token|"
        r"\$[\d.]+|<\s*\d+\s*(?:ms|s\b)|>\s*\d+)"
    )
    for line in draft.split("\n"):
        if quant_pattern.search(line) and line.strip() and not line.strip().startswith("|"):
            _add(line)

    # Prose-form technology choices ("We recommend X", "Using Y for...")
    for line in draft.split("\n"):
        if _PROSE_DECISION_RE.search(line) and line.strip():
            _add(line)

    # Mermaid diagram node labels (A["FAISS"], B["Kubernetes"])
    for m in _MERMAID_NODE_RE.finditer(draft):
        label = m.group(1).strip()
        if len(label) > 3:
            _add(f"[diagram] {label}")

    if decisions:
        settled = "\n".join(f"- {d}" for d in decisions[:25])
        parts.append(f"SETTLED DECISIONS (preserve unless reviewer flagged):\n{settled}")


_DECISIVE_BLOCK = """\

DECISIVENESS (user explicitly requested committed recommendations):
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
        req_bullets = "\n".join(f"    - {r}" for r in requirements[:10])
        parts.append(
            "SYSTEM CAPABILITIES (each must be addressed in depth, not just mentioned in passing):\n" + req_bullets
        )

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
    """Build a ## Sources section from evidence packet provenance.

    Sources are ordered by packet confidence (highest first) and capped at
    ``settings.max_cited_sources``.  When ``settings.sources_collapsible``
    is True the section is wrapped in an HTML ``<details>`` block so
    markdown renderers (e.g. OpenWebUI) can collapse it.
    """
    packets = state.get("evidence_packets") or []
    if not packets:
        return ""

    sorted_packets = sorted(
        packets,
        key=lambda p: float(p.get("confidence", 0) if isinstance(p, dict) else getattr(p, "confidence", 0)),
        reverse=True,
    )

    seen: set[str] = set()
    lines: list[str] = []
    cap = settings.max_cited_sources
    for p in sorted_packets:
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

            badge = f" [{authority.title()}]" if authority else ""
            display = doc_name or uri
            url_part = f" — {uri}" if uri.startswith("http") else ""
            lines.append(f"- {display}{url_part}{badge}")

            if len(lines) >= cap:
                break
        if len(lines) >= cap:
            break

    if not lines:
        return ""

    body = "\n".join(lines)
    if settings.sources_collapsible:
        return f"## Sources\n\n<details>\n<summary>{len(lines)} sources consulted</summary>\n\n{body}\n</details>"
    return "## Sources\n\n" + body


def _build_available_sources(packets: list[dict[str, Any] | Any]) -> str:
    """Extract deduplicated (doc_name, uri) pairs from evidence packets.

    Capped at ``settings.max_cited_sources`` so the LLM only sees (and can
    cite) the same number of sources we allow in the final output.
    Packets are sorted by confidence so the highest-quality sources are shown.
    """
    sorted_packets = sorted(
        packets,
        key=lambda p: float(p.get("confidence", 0) if isinstance(p, dict) else getattr(p, "confidence", 0)),
        reverse=True,
    )
    cap = settings.max_cited_sources
    seen: set[str] = set()
    lines: list[str] = []
    for p in sorted_packets:
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
            if len(lines) >= cap:
                break
        if len(lines) >= cap:
            break
    if not lines:
        return ""
    return "## AVAILABLE SOURCES (cite ONLY these URLs)\n" + "\n".join(lines) + "\n"


async def writer_node(state: dict[str, Any]) -> dict[str, Any]:
    """Produce the full response from plan outline + evidence packets."""
    start = time.monotonic()
    node_name = "writer"

    # Build evidence from Router's evidence packets (summaries + top snippets).
    # Group by section_id so each plan section gets proportional budget.
    difficulty = state.get("difficulty", 0.5)
    packets = state.get("evidence_packets") or []
    packets = sorted(
        packets,
        key=lambda p: float(p.get("confidence", 0) if isinstance(p, dict) else getattr(p, "confidence", 0)),
        reverse=True,
    )

    max_snips = 5 if difficulty >= 0.7 else 3
    min_rel = 0.45 if difficulty >= 0.7 else 0.6

    section_groups: dict[int | None, list[str]] = {}
    for p in packets:
        summary = p.get("summary", "") if isinstance(p, dict) else getattr(p, "summary", "")
        if not summary:
            continue
        snippets = p.get("snippets", []) if isinstance(p, dict) else getattr(p, "snippets", [])
        top_snippets = _extract_top_snippets(snippets, max_snippets=max_snips, min_relevance=min_rel)
        if top_snippets:
            snippet_block = "\n".join(f"  > {s}" for s in top_snippets)
            part = f"{summary}\n\nKey excerpts:\n{snippet_block}"
        else:
            part = summary
        sid = p.get("section_id") if isinstance(p, dict) else getattr(p, "section_id", None)
        section_groups.setdefault(sid, []).append(part)

    evidence_budget = settings.scaled_evidence_budget(difficulty)
    # Safety guard: evidence must not starve the output budget
    max_evidence_chars = (settings.compiler_model_context * 4) - (settings.writer_budget_max * 4) - 8000
    if evidence_budget > max_evidence_chars > 0:
        evidence_budget = max_evidence_chars
    num_groups = max(len(section_groups), 1)
    per_section_budget = evidence_budget // num_groups

    compiled_sections: list[str] = []
    budget_remaining = evidence_budget
    for sid, parts in section_groups.items():
        if settings.long_context_reorder_enabled and len(parts) > 2:
            parts = _long_context_reorder(parts)
        section_text = "\n---\n".join(parts)
        allowed = min(len(section_text), max(per_section_budget, budget_remaining // max(num_groups, 1)))
        section_text = section_text[:allowed]
        budget_remaining -= len(section_text)
        num_groups -= 1
        compiled_sections.append(section_text)

    compiled_evidence = "\n---\n".join(compiled_sections)

    task_block = _build_task_block(state)
    outline_block = _build_outline_block(state)

    # Trivial fast-path: frame_extractor and planner are skipped, so
    # user_task / execution_plan are empty.  Fall back to the raw user
    # question so the writer always knows what was asked.
    if not task_block:
        raw_question = (state.get("last_user_content") or state.get("task_description") or "").strip()
        if raw_question:
            task_block = f"User question: {raw_question}"

    style_contract = state.get("style_contract_locked") or {}
    verbosity = style_contract.get("verbosity_target", "moderate")

    writer_budget = settings.scaled_writer_budget(difficulty)
    if difficulty < 0.2:
        writer_budget = max(512, min(writer_budget, settings.writer_budget_max))
    else:
        writer_budget = max(2048, min(writer_budget, settings.writer_budget_max))

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

        # Epistemic, discovery, and required_elements are gated on
        # difficulty — they add valuable structure for medium/hard tasks
        # but overwhelm trivial/easy responses with unnecessary scaffolding.
        if difficulty >= 0.5:
            epistemic = (taxonomy_meta.get("epistemic_guidance") or "").strip()
            if epistemic:
                system_prompt += f"\n\nEPISTEMIC DISCIPLINE:\n{epistemic}"

        if difficulty >= 0.4:
            discovery = (taxonomy_meta.get("discovery_prompt") or "").strip()
            if discovery:
                lock = state.get("cohesion_lock") or {}
                entity = lock.get("entity", "")
                if entity:
                    system_prompt += f"\n\nDISCOVERY (stay within the frame of {entity}):\n{discovery}"
                else:
                    system_prompt += f"\n\nDISCOVERY:\n{discovery}"

        if difficulty >= 0.5:
            required_elements = taxonomy_meta.get("required_elements") or []
            if required_elements:
                elems = "\n".join(f"- {e}" for e in required_elements)
                system_prompt += (
                    "\n\nDOMAIN COVERAGE CHECKLIST (secondary to the Document Outline above):\n"
                    "The Document Outline is your primary structure. Additionally, ensure "
                    "these domain-mandated topics are covered somewhere in the response "
                    "(they may already appear in the outline):\n" + elems
                )

    if difficulty >= 0.7:
        style_contract = state.get("style_contract_locked") or {}
        verbosity = style_contract.get("verbosity_target", "moderate")
        if verbosity == "concise":
            system_prompt += (
                "\n\nSECTION DEPTH (high-complexity, concise):\n"
                "- Each section must contain concrete specifics — but keep it tight.\n"
                "- Name specific tools, services, and versions — not abstract categories.\n"
                "- A section that could apply to any project without modification is a failure."
            )
        else:
            system_prompt += (
                "\n\nSECTION DEPTH (high-complexity task):\n"
                "- Each section must contain 2-4 substantive paragraphs with concrete details.\n"
                "- Name specific tools, services, and versions — not abstract categories.\n"
                "- If evidence for a section is thin, explicitly state what is missing "
                "rather than padding with generic advice.\n"
                "- A section that could apply to any project without modification is a failure."
            )

    revision_context = _build_revision_context(state)

    user_msg = f"{task_block}\n{outline_block}\nTarget verbosity: {verbosity}\n\n"

    if revision_context:
        user_msg += revision_context + "\n"

    if decisive:
        user_msg += _DECISIVE_BLOCK + "\n"

    if compiled_evidence:
        user_msg += f'## Evidence\n<context trust="untrusted">\n{compiled_evidence}\n</context>\n'

    available_sources = _build_available_sources(packets)
    if available_sources:
        user_msg += f"\n{available_sources}\n"

    from ..token_utils import estimate_tokens

    model_context = settings.compiler_model_context
    estimated_input_tokens = estimate_tokens(system_prompt + user_msg, writer_name)
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
        writer_budget = max(512 if difficulty < 0.2 else 2048, available_output)

    iteration = state.get("iteration_count", 0)
    _used_raw_fallback = not bool(_build_task_block(state))
    logger.info(
        "writer_start",
        extra={
            "evidence_len": len(compiled_evidence),
            "task_block_len": len(task_block),
            "outline_len": len(outline_block),
            "revision_context_len": len(revision_context),
            "iteration": iteration,
            "writer_budget": writer_budget,
            "input_estimate": estimated_input_tokens,
            "difficulty": round(difficulty, 2),
            "user_msg_preview": (task_block or "")[:120],
            "has_task_frame": not _used_raw_fallback,
            "has_outline": bool(outline_block),
            "has_evidence": bool(compiled_evidence),
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
            model_kwargs=(
                {"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}}
                if settings.guided_json_enabled
                else {}
            ),
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

        # Replace any LLM-generated Sources section with the controlled
        # provenance-based one (capped, confidence-sorted, collapsible).
        compiled = re.split(r"\n##\s+Sources\b", compiled, maxsplit=1)[0].rstrip()
        sources_section = _build_sources_section(state)
        if sources_section:
            compiled = compiled + "\n\n" + sources_section

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

        from ..token_utils import track_budget

        new_budget = track_budget(state, result, role="writer")

        return {
            "generated_code": compiled,
            "compiled_answer": compiled,
            "draft_fingerprints": [fingerprint_draft(compiled)],
            "error": None,
            "current_node": node_name,
            "token_budget_remaining": new_budget,
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
