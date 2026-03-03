"""Planner node -- breaks down tasks into structured plans (JCS).

Uses Qwen3-14B (same as Supervisor) to produce a plan
with steps, dependencies, and open questions before code generation.
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
from ..schemas import PlannerOut, parse_and_validate
from ..state import NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.planner")

# Atomic Planner: Each step is ATOMIC. Max 3 files per step. Every step MUST have verification_command.
PLANNER_SYSTEM_PROMPT = """\
You are the Planner in a Safety-II Joint Cognitive System called Synesis.
Your role is ATOMIC decomposition: break the task into small, verifiable steps. You do NOT write code.

ATOMIC RULES:
- One step = max 3 files. Every step MUST have verification_command (runnable command to verify the step).
- For protocol tasks (ActivityPub, Fediverse, WebFinger): FIRST step = discovery/WebFinger only. Do NOT plan the full app in one step.
- Build incrementally: step 1 verifies before step 2 starts.

You MUST respond with valid JSON:
{
  "plan": {
    "steps": [
      {"id": 1, "action": "Implement WebFinger discovery", "dependencies": [], "files": ["webfinger.py"], "verification_command": "python -c \"from webfinger import lookup; print(lookup('user@example.com'))\""},
      {"id": 2, "action": "Add Actor document", "dependencies": [1], "files": ["actor.py"], "verification_command": "python actor.py"}
    ],
    "open_questions": [],
    "assumptions": []
  },
  "touched_files": ["webfinger.py", "actor.py"],
  "reasoning": "Brief",
  "confidence": 0.0 to 1.0
}

touched_files: All paths the Executor may modify (union of step.files). Paths under workspace root.
Keep plans concise. 1-3 steps for simple; more for complex. Add open_questions if underspecified.
"""

planner_llm = ChatOpenAI(
    base_url=settings.planner_model_url,
    api_key="not-needed",
    model=settings.planner_model_name,
    temperature=0.2,
    max_tokens=1024,  # 1-5 steps ~200-600 tokens; 2048 was overkill and slowed generation
    http_client=get_llm_http_client(uds_path=settings.planner_model_uds or None),
)


def _build_context_block(rag_context: list[str]) -> str:
    if not rag_context:
        return ""
    joined = "\n---\n".join(rag_context[:5])
    return f"\n\n## Reference (from RAG)\nRelevant context:\n{joined}"


async def planner_node(state: dict[str, Any]) -> dict[str, Any]:
    start = time.monotonic()
    node_name = "planner"

    # Short-circuit: output_type=document should not reach Planner (plan_required=false). If we do, skip
    # the code decomposition LLM — Planner is for code steps only, not document plans.
    if state.get("output_type") == "document":
        latency = (time.monotonic() - start) * 1000
        logger.info("planner_skipped_output_type_document", extra={"output_type": "document", "latency_ms": latency})
        return {
            "execution_plan": {"steps": [{"id": 1, "action": "Produce document/plan", "dependencies": [], "files": [], "verification_command": ""}], "open_questions": [], "assumptions": []},
            "touched_files": [],
            "plan_pending_approval": False,
            "deliverable_type": "explain_only",
            "allowed_tools": ["none"],
            "target_language": "markdown",
            "current_node": node_name,
            "next_node": "worker",
            "node_traces": [],
        }

    try:
        task_desc = state.get("task_description", "")
        target_lang = state.get("target_language", "python")
        from ..context_resolver import get_resolved_rag_context

        rag_context = get_resolved_rag_context(state)
        assumptions = state.get("assumptions", [])
        if isinstance(assumptions, list):
            assumptions_str = ", ".join(assumptions) if assumptions else "None stated"
        else:
            assumptions_str = str(assumptions)

        context_block = _build_context_block(rag_context)

        # Domain-specific decomposition rules (Sovereign alignment)
        from ..vertical_resolver import (
            get_planner_decomposition_rules,
            resolve_active_vertical,
        )

        active_vertical = resolve_active_vertical(
            active_domain_refs=state.get("active_domain_refs"),
            platform_context=state.get("platform_context"),
        )
        decomposition_rules = get_planner_decomposition_rules(active_vertical)
        domain_rules_block = ""
        if decomposition_rules:
            domain_rules_block = f"\n\n## Domain-Specific Rules ({active_vertical})\n{decomposition_rules}\n"

        prompt = (
            f"## Task\nLanguage: {target_lang}\n{task_desc}\n"
            f"## Supervisor assumptions\n{assumptions_str}"
            f"{context_block}{domain_rules_block}\n\n"
            f"Produce a structured execution plan for the Executor to follow."
        )

        messages = [
            SystemMessage(content=PLANNER_SYSTEM_PROMPT),
            HumanMessage(content=prompt),
        ]

        response = await planner_llm.ainvoke(messages)

        try:
            parsed = parse_and_validate(response.content, PlannerOut)
        except Exception as e:
            logger.warning(f"Planner schema validation failed: {e}")
            content = response.content
            json_start = content.find("{")
            json_end = content.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                data = json.loads(content[json_start:json_end])
                plan = data.get("plan", data)
                if isinstance(plan, dict):
                    parsed = PlannerOut(
                        plan=plan,
                        open_questions=plan.get("open_questions", data.get("open_questions", [])),
                        assumptions=plan.get("assumptions", data.get("assumptions", [])),
                        touched_files=data.get("touched_files", []),
                        reasoning=data.get("reasoning", ""),
                        confidence=data.get("confidence", 0.5),
                    )
                else:
                    parsed = PlannerOut(
                        plan={"steps": [], "open_questions": [], "assumptions": []},
                        reasoning=str(e),
                        confidence=0.3,
                    )
            else:
                parsed = PlannerOut(
                    plan={"steps": [], "open_questions": [], "assumptions": []},
                    reasoning="Parse failed",
                    confidence=0.2,
                )

        plan = parsed.plan
        if parsed.open_questions:
            plan = {**plan, "open_questions": parsed.open_questions}
        if parsed.assumptions:
            plan = {**plan, "assumptions": parsed.assumptions}

        touched_files = getattr(parsed, "touched_files", []) or []

        latency = (time.monotonic() - start) * 1000
        trace = NodeTrace(
            node_name=node_name,
            reasoning=parsed.reasoning,
            assumptions=parsed.assumptions,
            confidence=parsed.confidence,
            outcome=NodeOutcome.SUCCESS,
            latency_ms=latency,
            tokens_used=response.usage_metadata.get("total_tokens", 0) if response.usage_metadata else 0,
        )

        logger.info(
            "planner_completed",
            extra={
                "steps": len(plan.get("steps", [])),
                "open_questions": len(plan.get("open_questions", [])),
                "confidence": parsed.confidence,
                "latency_ms": latency,
            },
        )

        steps = plan.get("steps", [])
        # EntryClassifier sets plan_required=false for trivial/small; skip approval for those
        plan_required = state.get("plan_required", True)
        needs_approval = plan_required and settings.require_plan_approval and len(steps) > 0

        # Defensive: output_type=document → skip approval (taxonomy-driven; document tasks should not reach Planner normally)
        if needs_approval and state.get("output_type") == "document":
            needs_approval = False
            logger.info("planner_skip_approval_output_type_document", extra={"output_type": "document"})

        next_node = "respond" if needs_approval else "worker"

        out: dict[str, Any] = {
            "execution_plan": plan,
            "touched_files": touched_files,
            "plan_pending_approval": needs_approval,
            "current_node": node_name,
            "next_node": next_node,
            "node_traces": [trace],
        }
        if not needs_approval and state.get("output_type") == "document":
            out["deliverable_type"] = "explain_only"
            out["allowed_tools"] = ["none"]
            out["target_language"] = "markdown"
        return out

    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.exception("planner_error")
        trace = NodeTrace(
            node_name=node_name,
            reasoning=f"Error: {e}",
            assumptions=[],
            confidence=0.0,
            outcome=NodeOutcome.ERROR,
            latency_ms=latency,
        )
        return {
            "execution_plan": {},
            "touched_files": [],  # §7.2: Planner must always produce touched_files (even [])
            "current_node": node_name,
            "next_node": "worker",
            "error": str(e),
            "node_traces": [trace],
        }
