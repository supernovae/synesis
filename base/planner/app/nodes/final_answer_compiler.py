"""FinalAnswerCompilerNode — write polished user-facing prose from section text.

This node receives the merged section text (generated_code) and the
structured task_frame from the frame extractor, and produces a polished
markdown response.  The final_scrubber downstream handles deterministic
artifact cleanup as a safety net.

Two compilation modes:
  - Full rewrite: when sections fit within the compiler model context,
    the LLM rewrites the entire document for coherence and polish.
  - Light compilation: when sections overflow context, the LLM writes
    only an intro + conclusion. Individually-polished sections pass
    through directly (they're already well-written by section workers).
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..config import settings
from ..llm_telemetry import get_llm_http_client
from ..model_policy import ModelContext, resolve_model
from ..prompt_spine import EPISTEMIC_WRITER, REGULATED_FLOOR_UNIVERSAL, TRUST_UNTRUSTED_CONTEXT
from ..state import NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.final_answer_compiler")

_COMPILER_SYSTEM_TEMPLATE = """\
You are the Final Answer Writer. You receive approved section text and a \
structured task specification, and produce a well-formatted response for the user.

{regulated_and_epistemic}

TRUST: {trust_spine}

CONTENT RULES:
1. Answer the main question FIRST in the opening paragraph.
2. Satisfy explicit requirements in the order they appear.
3. When the task calls for a single recommended approach, commit to one primary \
   choice per decision point and justify it; when the task is comparative, use \
   tables and tradeoffs without forcing an arbitrary pick unless the user asked for one.
4. Weave evidence naturally into prose.
5. Label assumptions inline only when materially relevant.
6. Qualify unsupported claims with "roughly" / "approximately" or omit.
7. Include risks only when they have real mitigation value.
8. Strip any model scratchpad or chain-of-thought blocks, \
   self-narration ("Okay, I need to..."), or section HTML comments.
9. Do not invent information not present in the section text.

FORMATTING — pick the right element for the content:
- TABLE (pipe syntax with header row) when comparing options, models, \
  tools, or alternatives side-by-side.
- NUMBERED LIST when describing ordered steps or a procedure.
- BULLET LIST when listing features, properties, or unordered items.
- CODE BLOCK (```lang) when showing commands, config, or file paths.
- DIAGRAM (```mermaid) when visualizing architecture, data flow, \
  sequences, or component relationships. Diagrams are valuable and \
  do not count against verbosity limits.
  In mermaid nodes, ALWAYS quote labels containing parentheses or special \
  characters, e.g. A["Storage layer (detail)"] not A[Storage layer (detail)]. Never use \
  markdown list lines (- or *) inside a mermaid block — use %% comments \
  or prose outside the fence if you need notes.
- PROSE when explaining reasoning, tradeoffs, or narrative analysis.
- Use inline `backticks` for tool, command, and model names.
- Do NOT bold keywords just to signal coverage.

CITATION RULES:
- When section text cites sources, use numbered inline references \
  [1], [2], etc. at the point of use.
- Authority badges: mark cited sources as [Canonical], [Vetted], \
  [Community], or [External] based on the source's authority tier.
- At the end of the response, add a "## Sources" section listing all \
  cited sources in order: [N] Document Name — URL (Authority badge).
- Only include sources that are actually referenced in the body text.
- If no claims have source citations, omit the Sources section entirely.

HEADING STYLE:
- Do NOT use "Deep Dive" as a heading unless the user explicitly asked for one.
- Use descriptive headings that name the content topic — NOT the user's imperative phrasing.
  Bad: "Explain How Retrieval Should Work", "Propose a Concrete Architecture".
  Good: "Retrieval Architecture", "System Architecture".
- Headings should read as a table of contents for an expert document, not a checklist of user demands.

{output_directive}
"""


def _build_compiler_system(state: dict[str, Any]) -> str:
    """Build the compiler system prompt with format-aware output directive."""
    from ..schemas import STRUCTURED_FORMATS
    from ..taxonomy_prompt_factory import get_epistemic_guidance_block, get_writer_regulated_block

    frame = state.get("task_frame") or {}
    fmt = frame.get("requested_format", "prose")
    schema_fields = frame.get("output_schema") or []
    embedded = frame.get("embedded_formats") or []

    if fmt in STRUCTURED_FORMATS:
        schema_hint = ""
        if schema_fields:
            schema_hint = f"\nRequired top-level keys/fields: {', '.join(schema_fields)}"
        directive = (
            f"OUTPUT: Valid {fmt.upper()} document. Do NOT wrap in markdown or add "
            f"markdown headings. The entire response must be parseable as {fmt}."
            f"{schema_hint}"
        )
    else:
        directive = "OUTPUT: Markdown with section headings. No JSON wrapper."
        if embedded:
            fmt_tags = ", ".join(f"`{e}`" for e in embedded)
            directive += (
                f"\nThe user expects {fmt_tags} examples. Use triple-backtick fenced "
                f"code blocks with the appropriate language tag. The overall response "
                f"MUST remain well-formatted markdown."
            )
            if schema_fields:
                directive += f"\nRequired schema fields: {', '.join(schema_fields)}"

    meta = state.get("taxonomy_metadata") or {}
    l2_parts = [REGULATED_FLOOR_UNIVERSAL.strip(), EPISTEMIC_WRITER.strip()]
    eg = get_epistemic_guidance_block(meta)
    if eg:
        l2_parts.append(f"Taxonomy epistemics: {eg}")
    wr = get_writer_regulated_block(meta)
    if wr:
        l2_parts.append(f"Taxonomy regulated context: {wr}")
    regulated_and_epistemic = "\n\n".join(l2_parts)

    return _COMPILER_SYSTEM_TEMPLATE.format(
        output_directive=directive,
        regulated_and_epistemic=regulated_and_epistemic,
        trust_spine=TRUST_UNTRUSTED_CONTEXT.strip(),
    )


_LIGHT_COMPILER_SYSTEM = """\
You are the Final Answer Writer. A team of specialist writers has already \
produced the full document. Your ONLY job is to write two small pieces:

PIECE 1 — INTRODUCTION (3-5 sentences):
  - Start with a top-level heading: # [Descriptive Title]
  - Answer the main question directly in the first sentence.
  - Briefly preview the document structure (e.g. "Below we cover X, Y, and Z.").
  - Do NOT reproduce any section content or headings.

PIECE 2 — CONCLUSION (2-3 sentences):
  - Summarize the key takeaways and recommended next steps.
  - Do NOT list or repeat the section headings.

CRITICAL RULES:
- Do NOT write, echo, or summarize any section content. The sections are \
  inserted automatically between your intro and conclusion.
- Do NOT include section headings, outlines, or bullet lists of topics.
- Do NOT use "Deep Dive" or echo the user's imperative phrasing.

OUTPUT FORMAT — return EXACTLY this structure:
[your intro paragraph with # heading]
---SECTIONS---
[your conclusion paragraph]
"""

_SECTION_HEADING_RE = re.compile(r"^#{1,3}\s+.+$", re.MULTILINE)


def _strip_echoed_headings(text: str, section_text: str) -> str:
    """Remove lines from intro/conclusion that duplicate section headings."""
    if not text:
        return text
    section_headings = {h.group().strip().lower() for h in _SECTION_HEADING_RE.finditer(section_text)}
    if not section_headings:
        return text

    lines = text.split("\n")
    kept: list[str] = []
    for line in lines:
        stripped = line.strip().lower()
        if stripped.startswith("#") and any(
            stripped == h or stripped.rstrip(":") == h.rstrip(":") for h in section_headings
        ):
            continue
        # Also strip truncated heading echoes (e.g. first 80 chars of a heading)
        if stripped.startswith("#") and any(
            stripped[:60] in h or h[:60] in stripped for h in section_headings if len(h) > 20
        ):
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def _extract_section_outline(section_text: str, max_sections: int = 15) -> str:
    """Extract headings + first sentence from each section for light compilation."""
    sections = section_text.split("\n\n---\n\n")
    outline_parts: list[str] = []
    for i, sec in enumerate(sections[:max_sections]):
        lines = sec.strip().split("\n")
        heading = ""
        first_line = ""
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("#"):
                heading = stripped
            elif not first_line and len(stripped) > 20:
                first_line = stripped[:150]
                break
        if heading:
            outline_parts.append(f"{heading}\n{first_line}" if first_line else heading)
    return "\n\n".join(outline_parts)


def _build_source_inventory(state: dict[str, Any]) -> str:
    """Build a deduplicated source list from RAG provenance for the compiler.

    Each source includes document name, URL, and authority tier so the
    compiler can build a proper Sources section.
    """
    doc_names = state.get("rag_document_names") or []
    source_urls = state.get("rag_source_urls") or []
    authorities = state.get("rag_authority_labels") or []

    if not doc_names and not source_urls:
        return ""

    seen: set[str] = set()
    lines: list[str] = []
    for i in range(max(len(doc_names), len(source_urls))):
        name = doc_names[i] if i < len(doc_names) else ""
        url = source_urls[i] if i < len(source_urls) else ""
        auth = authorities[i] if i < len(authorities) else ""

        key = (name or url).lower()
        if not key or key in seen:
            continue
        seen.add(key)

        badge = f" [{auth.title()}]" if auth else ""
        url_part = f" — {url}" if url else ""
        lines.append(f"- {name or '(unnamed)'}{url_part}{badge}")

    if not lines:
        return ""

    return (
        "\n\nAVAILABLE SOURCES (use these for the ## Sources section when claims reference them):\n"
        + "\n".join(lines)
        + "\n"
    )


def _build_sources_section(state: dict[str, Any]) -> str:
    """Build a ## Sources section from provenance data.

    Used by the light compiler to append a sources list since section
    workers may not have produced inline citations.
    """
    doc_names = state.get("rag_document_names") or []
    source_urls = state.get("rag_source_urls") or []
    authorities = state.get("rag_authority_labels") or []

    if not doc_names and not source_urls:
        return ""

    seen: set[str] = set()
    lines: list[str] = []
    idx = 0
    for i in range(max(len(doc_names), len(source_urls))):
        name = doc_names[i] if i < len(doc_names) else ""
        url = source_urls[i] if i < len(source_urls) else ""
        auth = authorities[i] if i < len(authorities) else ""

        key = (name or url).lower()
        if not key or key in seen:
            continue
        seen.add(key)
        idx += 1

        badge = f" [{auth.title()}]" if auth else ""
        url_part = f" — {url}" if url else ""
        lines.append(f"[{idx}] {name or '(unnamed)'}{url_part}{badge}")

    if not lines:
        return ""

    return "## Sources\n\n" + "\n".join(lines)


def _build_task_block(state: dict[str, Any]) -> str:
    """Build task_frame context block for the compiler prompt."""
    frame = state.get("task_frame") or {}
    if not frame:
        return ""

    parts: list[str] = []

    main_q = frame.get("main_question", "")
    if main_q:
        parts.append(f"Main question: {main_q}")

    goals = frame.get("goals") or []
    if goals:
        parts.append("Goals: " + "; ".join(goals[:8]))

    global_constraints = frame.get("global_constraints") or []
    if global_constraints:
        parts.append("Constraints: " + "; ".join(global_constraints[:6]))

    negative = frame.get("negative_constraints") or []
    if negative:
        parts.append("Do NOT: " + "; ".join(negative[:4]))

    tasks = frame.get("tasks") or []
    if tasks:
        detail_lines: list[str] = []
        for t in tasks:
            desc = t.get("description", "") if isinstance(t, dict) else getattr(t, "description", "")
            sub_reqs = (t.get("sub_requirements") or []) if isinstance(t, dict) else getattr(t, "sub_requirements", [])
            fmt = (t.get("format_hint") or "") if isinstance(t, dict) else getattr(t, "format_hint", "")
            line = desc
            if fmt:
                line += f" [format: {fmt}]"
            detail_lines.append(line)
            for sr in sub_reqs[:5]:
                detail_lines.append(f"      - {sr}")
        parts.append("Tasks (with sub-requirements and format hints):\n" + "\n".join(f"    {l}" for l in detail_lines))

    evaluation = frame.get("evaluation") or []
    if evaluation:
        parts.append("Success criteria: " + "; ".join(evaluation[:6]))

    # Output format is handled by the OUTPUT directive in the compiler system prompt.
    output_schema = frame.get("output_schema") or []
    if output_schema:
        parts.append(f"Required output schema fields: {', '.join(output_schema)}")

    if not parts:
        return ""

    return "## User Task\n" + "\n".join(f"- {p}" for p in parts) + "\n"


_MIN_FULL_REWRITE_HEADROOM = 3072  # tokens — below this, light mode is better


async def final_answer_compiler_node(state: dict[str, Any]) -> dict[str, Any]:
    """Compile polished prose from approved section text and task_frame.

    Two modes based on whether sections fit in the compiler model context:
      - Full rewrite: LLM rewrites the entire document.
      - Light compilation: LLM writes intro + conclusion only; sections
        pass through directly (already polished by section workers).
    """
    start = time.monotonic()
    node_name = "final_answer_compiler"

    section_text = state.get("generated_code", "")
    if not section_text or len(section_text.strip()) < 100:
        logger.warning("compiler_skip_empty")
        return {
            "compiled_answer": section_text,
            "current_node": node_name,
        }

    difficulty = state.get("difficulty", 0.5)
    writer_budget = settings.scaled_writer_budget(difficulty)
    writer_budget = max(2048, min(writer_budget, 12288))

    _fac_res = resolve_model("general", ModelContext(difficulty=difficulty))
    writer_url = _fac_res.base_url
    writer_name = _fac_res.model_name

    task_block = _build_task_block(state)
    source_inventory = _build_source_inventory(state)

    style_contract = state.get("style_contract_locked") or {}
    verbosity = style_contract.get("verbosity_target", "moderate")

    logger.info(
        "compiler_source_inventory",
        extra={
            "source_count": source_inventory.count("- ") if source_inventory else 0,
            "has_urls": bool(state.get("rag_source_urls")),
            "url_count": len([u for u in (state.get("rag_source_urls") or []) if u]),
            "doc_name_count": len([n for n in (state.get("rag_document_names") or []) if n]),
            "inventory_preview": source_inventory[:300] if source_inventory else "(empty)",
        },
    )

    from ..token_utils import estimate_tokens

    compiler_system = _build_compiler_system(state)

    model_context = settings.compiler_model_context
    full_input = f"{compiler_system}\n{task_block}\n{section_text}{source_inventory}"
    estimated_input_tokens = estimate_tokens(full_input, writer_name)
    available_output = model_context - estimated_input_tokens - 256

    use_light_mode = available_output < _MIN_FULL_REWRITE_HEADROOM

    if use_light_mode:
        return await _light_compile(
            section_text,
            state,
            task_block,
            source_inventory,
            verbosity,
            writer_url,
            writer_name,
            model_context,
            start,
            node_name,
        )

    # Full rewrite mode — sections fit in context
    user_msg = f"{task_block}\nTarget verbosity: {verbosity}\n\n## Approved Sections\n{section_text}{source_inventory}"

    estimated_input_tokens = estimate_tokens(compiler_system + user_msg, writer_name)
    available_output = model_context - estimated_input_tokens - 256
    if writer_budget > available_output:
        writer_budget = max(2048, available_output)

    logger.info(
        "compiler_full_rewrite",
        extra={
            "input_estimate": estimated_input_tokens,
            "writer_budget": writer_budget,
            "section_len": len(section_text),
        },
    )

    try:
        llm = ChatOpenAI(
            base_url=writer_url,
            api_key=settings.model_api_key,
            model=writer_name,
            temperature=0.3,
            max_completion_tokens=writer_budget,
            streaming=True,
            stream_usage=True,
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
                SystemMessage(content=compiler_system),
                HumanMessage(content=user_msg),
            ]
        )

        compiled = (result.content or "").strip()
        if not compiled or len(compiled) < 50:
            logger.warning("compiler_output_too_short")
            compiled = section_text

        # If the compiler didn't produce a Sources section, append one
        if "## Sources" not in compiled:
            sources_section = _build_sources_section(state)
            if sources_section:
                compiled = compiled.rstrip() + "\n\n" + sources_section

        latency = (time.monotonic() - start) * 1000
        logger.info(
            "compiler_complete",
            extra={
                "mode": "full_rewrite",
                "output_len": len(compiled),
                "section_len": len(section_text),
                "latency_ms": round(latency),
            },
        )

        from ..token_utils import track_budget

        new_budget = track_budget(state, result, role="compiler")

        return {
            "compiled_answer": compiled,
            "current_node": node_name,
            "token_budget_remaining": new_budget,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"Full rewrite: {len(compiled)} chars from {len(section_text)} chars",
                    confidence=0.85,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=latency,
                )
            ],
        }

    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.warning("compiler_failed", exc_info=True)
        return {
            "compiled_answer": section_text,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"Compilation failed, using raw sections: {e}",
                    confidence=0.0,
                    outcome=NodeOutcome.ERROR,
                    latency_ms=latency,
                )
            ],
        }


async def _light_compile(
    section_text: str,
    state: dict[str, Any],
    task_block: str,
    source_inventory: str,
    verbosity: str,
    writer_url: str,
    writer_name: str,
    model_context: int,
    start: float,
    node_name: str,
) -> dict[str, Any]:
    """Light compilation: LLM writes intro + conclusion; sections pass through.

    Used when sections are too large for a full rewrite within the model's
    context window. The section workers have already produced polished content,
    so this mode adds cohesion without lossy compression.
    """
    from ..token_utils import estimate_tokens

    outline = _extract_section_outline(section_text)

    user_msg = f"{task_block}\nTarget verbosity: {verbosity}\n\n## Section Outline\n{outline}{source_inventory}"

    estimated_input = estimate_tokens(_LIGHT_COMPILER_SYSTEM + user_msg, writer_name)
    budget = min(2048, model_context - estimated_input - 256)
    budget = max(512, budget)

    logger.info(
        "compiler_light_mode",
        extra={
            "section_len": len(section_text),
            "outline_len": len(outline),
            "budget": budget,
            "input_estimate": estimated_input,
        },
    )

    # Clean up section separators for final output
    cleaned_sections = section_text.replace("\n\n---\n\n", "\n\n")

    try:
        llm = ChatOpenAI(
            base_url=writer_url,
            api_key=settings.model_api_key,
            model=writer_name,
            temperature=0.3,
            max_completion_tokens=budget,
            streaming=False,
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
                SystemMessage(content=_LIGHT_COMPILER_SYSTEM),
                HumanMessage(content=user_msg),
            ]
        )

        llm_output = (result.content or "").strip()

        # Parse intro and conclusion from LLM output.
        # Accept both separator variants the LLM might produce.
        intro = ""
        conclusion = ""
        for sep in ("---SECTIONS---", "---SECTIONS_HERE---"):
            if sep in llm_output:
                parts = llm_output.split(sep, 1)
                intro = parts[0].strip()
                conclusion = parts[1].strip() if len(parts) > 1 else ""
                break
        else:
            intro = llm_output
            conclusion = ""

        # Guard: strip any echoed section headings from intro or conclusion.
        intro = _strip_echoed_headings(intro, section_text)
        conclusion = _strip_echoed_headings(conclusion, section_text)

        # If the conclusion is mostly headings or outline-like, discard it.
        conclusion_lines = [l for l in conclusion.split("\n") if l.strip()]
        if (
            conclusion_lines
            and sum(1 for l in conclusion_lines if l.strip().startswith("#")) > len(conclusion_lines) * 0.3
        ):
            logger.info("compiler_light_discarding_outline_conclusion")
            conclusion = ""

        # Assemble: intro + full sections + conclusion + sources
        assembled_parts = []
        if intro:
            assembled_parts.append(intro)
        assembled_parts.append(cleaned_sections)
        if conclusion:
            assembled_parts.append(conclusion)

        sources_section = _build_sources_section(state)
        if sources_section:
            assembled_parts.append(sources_section)

        compiled = "\n\n".join(assembled_parts)

        latency = (time.monotonic() - start) * 1000
        logger.info(
            "compiler_complete",
            extra={
                "mode": "light",
                "output_len": len(compiled),
                "section_len": len(section_text),
                "intro_len": len(intro),
                "conclusion_len": len(conclusion),
                "latency_ms": round(latency),
            },
        )

        return {
            "compiled_answer": compiled,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"Light compile: intro({len(intro)})+sections({len(section_text)})+conclusion({len(conclusion)})",
                    confidence=0.8,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=latency,
                )
            ],
        }

    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.warning("compiler_light_failed", exc_info=True)
        return {
            "compiled_answer": cleaned_sections,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"Light compilation failed, using cleaned sections: {e}",
                    confidence=0.5,
                    outcome=NodeOutcome.ERROR,
                    latency_ms=latency,
                )
            ],
        }
