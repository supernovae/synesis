"""DecisionRecordBuilderNode — compress approved sections into a structured DecisionRecord.

This node is the architectural keystone of the writer isolation design.
It receives raw section text (~8-18K tokens) and produces a compact
DecisionRecord (~1.5-2.5K tokens) that is the ONLY input to the
FinalAnswerCompiler.  Internal reasoning, planning artifacts, and
chain-of-thought are intentionally discarded.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..config import settings
from ..llm_telemetry import get_llm_http_client
from ..schemas import DecisionRecord, parse_and_validate
from ..state import NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.decision_record_builder")

_DR_BUILDER_SYSTEM = """\
You are a structured-data extractor. Your job is to read the approved \
response sections and compress them into a DecisionRecord JSON object.

RULES:
- Extract key decisions, claims, risks, and assumptions from the sections.
- Discard narrative scaffolding, self-narration, thinking blocks, and \
  Toulmin labels (CLAIM/GROUNDS/WARRANT/etc.).
- Classify each claim's support: "grounded" (cited evidence), "inferred" \
  (reasonable from context), "assumption" (stated or unstated), or \
  "unsupported" (no basis given).
- COMMIT TO ONE CHOICE per decision point. answer_strategy.selected_approach \
  must name ONE concrete approach, not "X or Y".  Put rejected options in \
  rejected_alternatives with the reason each was eliminated.
- PRESERVE SUBSTANCE: For each major claim, keep the concrete specifics — \
  tool names, version numbers, rejected alternatives with reasons, and \
  quantitative details. A claim like "use tiered models" is too thin; \
  instead: "use Mistral-7B for routing (chosen over Phi-3 because X), \
  Qwen3-32B for generation (chosen over Llama-3-70B because Y)."
- For each section, extract 2-4 claims with evidence summaries. \
  Aim for 10-20 total claims for complex queries, 5-8 for simpler ones.
- Preserve rejected alternatives in answer_strategy.rejected_alternatives \
  with the reason each was eliminated — not as open options.
- Preserve concrete examples and domain-specific details in evidence_summary.
- CITATION PRESERVATION: When sections cite sources (document names, URLs,
  authority tiers like [R:canonical]), carry them into grounded_claims:
  - Set evidence_summary to include the document name and URL
  - Each claim citing a source should have a "sources" array in its object
    with {"document_name": "...", "url": "...", "authority": "..."}
  - The compiler will use these to build a Sources section in the final output.
- Do NOT invent content not present in the sections.
- Output valid JSON matching the schema below. No markdown fences.

SCHEMA:
{
  "user_task": {
    "main_question": "...",
    "explicit_requirements": ["..."],
    "constraints": ["..."],
    "requested_format": "",
    "success_criteria": ["..."]
  },
  "answer_strategy": {
    "selected_approach": "...",
    "rejected_alternatives": ["..."],
    "priority_order": ["..."]
  },
  "content_plan": {
    "sections": ["section title", ...],
    "must_include": ["..."],
    "must_avoid": ["..."]
  },
  "grounded_claims": [
    {"claim": "...", "support_status": "grounded|inferred|assumption|unsupported", "evidence_summary": "", "sources": [{"document_name": "", "url": "", "authority": ""}]}
  ],
  "assumptions": [{"assumption": "...", "importance": "low|medium|high"}],
  "uncertainties": [{"issue": "...", "user_visible": true}],
  "risks": [{"risk": "...", "mitigation": ""}],
  "repair_constraints": [],
  "style_contract": {
    "direct_answer_first": true,
    "concise": true,
    "max_section_paragraphs": 5,
    "citation_required": false,
    "verbosity_target": "thorough"
  }
}
"""


async def decision_record_builder_node(state: dict[str, Any]) -> dict[str, Any]:
    """Compress approved section text into a structured DecisionRecord."""
    start = time.monotonic()
    node_name = "decision_record_builder"

    generated_code = state.get("generated_code", "")
    task_desc = state.get("task_description", "")
    execution_plan = state.get("execution_plan") or {}
    difficulty = state.get("difficulty", 0.5)

    if not generated_code or len(generated_code.strip()) < 100:
        logger.warning("dr_builder_skip_empty")
        return {
            "decision_record": None,
            "current_node": node_name,
        }

    # Reuse critic's task reconstruction if available
    task_recon_hint = ""
    repair_instructions = state.get("repair_instructions") or []
    requirement_coverage = state.get("requirement_coverage") or []
    if requirement_coverage:
        met = [r for r in requirement_coverage if r.get("status") == "met"]
        task_recon_hint = f"\nCritic found {len(met)}/{len(requirement_coverage)} requirements met."
    if repair_instructions:
        repairs = "; ".join(
            r.get("action", "") for r in repair_instructions[:3] if r.get("action")
        )
        if repairs:
            task_recon_hint += f"\nRepair constraints (preserve what works, fix these): {repairs}"

    # Determine verbosity target from difficulty
    if difficulty < 0.3:
        verbosity = "terse"
    elif difficulty > 0.7:
        verbosity = "thorough"
    else:
        verbosity = "moderate"

    # Scale input window by difficulty — complex prompts need more section text
    input_budget = 12000 if difficulty < 0.7 else 16000

    user_msg = (
        f"## User Task\n{task_desc[:2000]}\n\n"
        f"## Execution Plan\n{json.dumps(execution_plan.get('steps', [])[:10], default=str)[:1500]}\n\n"
        f"{task_recon_hint}\n\n"
        f"Target verbosity: {verbosity}\n\n"
        f"## Approved Sections (compress into DecisionRecord)\n"
        f"{generated_code[:input_budget]}"
    )

    writer_url = settings.writer_model_url or settings.executor_model_url
    writer_name = settings.writer_model_name or settings.executor_model_name

    try:
        # Scale builder output budget: complex queries need richer records
        builder_budget = 2048 if difficulty < 0.5 else (3072 if difficulty < 0.7 else 4096)

        llm = ChatOpenAI(
            base_url=writer_url,
            api_key="not-needed",
            model=writer_name,
            temperature=0.1,
            max_completion_tokens=builder_budget,
            streaming=False,
            use_responses_api=False,
            model_kwargs={"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}},
            http_client=get_llm_http_client(),
        )

        result = await llm.ainvoke([
            SystemMessage(content=_DR_BUILDER_SYSTEM),
            HumanMessage(content=user_msg),
        ])

        dr = parse_and_validate(result.content, DecisionRecord)

        # Scale style contract from difficulty
        dr.style_contract.verbosity_target = verbosity
        if verbosity == "thorough":
            dr.style_contract.max_section_paragraphs = max(dr.style_contract.max_section_paragraphs, 6)
            dr.style_contract.concise = False
        elif verbosity == "moderate":
            dr.style_contract.max_section_paragraphs = max(dr.style_contract.max_section_paragraphs, 4)

        latency = (time.monotonic() - start) * 1000
        logger.info(
            "dr_builder_complete",
            extra={
                "claims": len(dr.grounded_claims),
                "risks": len(dr.risks),
                "assumptions": len(dr.assumptions),
                "latency_ms": round(latency),
            },
        )

        return {
            "decision_record": dr.model_dump(),
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"Extracted {len(dr.grounded_claims)} claims, {len(dr.risks)} risks",
                    confidence=0.8,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=latency,
                )
            ],
        }

    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.warning("dr_builder_failed", exc_info=True)
        return {
            "decision_record": None,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"DecisionRecord extraction failed: {e}",
                    confidence=0.0,
                    outcome=NodeOutcome.ERROR,
                    latency_ms=latency,
                )
            ],
        }
