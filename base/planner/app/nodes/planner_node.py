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

PLANNER_SYSTEM_PROMPT = """\
You are the Planner in a Safety-II Joint Cognitive System called Synesis.
Your role is to break down the user's task into a structured execution plan.
You do NOT write code -- you produce a clear plan for the Executor to follow.

You MUST respond with valid JSON:
{
  "plan": {
    "steps": [
      {"id": 1, "action": "Parse input file", "dependencies": []},
      {"id": 2, "action": "Validate schema", "dependencies": [1]},
      {"id": 3, "action": "Generate output", "dependencies": [2]}
    ],
    "open_questions": ["List any ambiguities that need user or Executor to resolve"],
    "assumptions": ["List assumptions you're making"]
  },
  "touched_files": ["/app/src/main.py"],
  "open_questions": [],
  "assumptions": [],
  "reasoning": "Your reasoning for this plan",
  "confidence": 0.0 to 1.0
}

touched_files: List of file paths the Executor may modify. Prevents scope creep. For single-file tasks, one path. For multi-file, list all permitted paths. Paths must be under workspace root.

Keep plans concise. For simple tasks (single script, clear spec), 1-3 steps suffice.
For complex tasks (multi-file, migration), break into logical phases.
If the task is underspecified, add open_questions for the Executor or user to clarify.
"""

planner_llm = ChatOpenAI(
    base_url=settings.planner_model_url,
    api_key="not-needed",
    model=settings.planner_model_name,
    temperature=0.2,
    max_tokens=2048,
    http_client=get_llm_http_client(),
)


def _build_context_block(rag_context: list[str]) -> str:
    if not rag_context:
        return ""
    joined = "\n---\n".join(rag_context[:5])
    return f"\n\n## Reference (from RAG)\nRelevant context:\n{joined}"


async def planner_node(state: dict[str, Any]) -> dict[str, Any]:
    start = time.monotonic()
    node_name = "planner"

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

        prompt = (
            f"## Task\nLanguage: {target_lang}\n{task_desc}\n"
            f"## Supervisor assumptions\n{assumptions_str}"
            f"{context_block}\n\n"
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
        next_node = "respond" if needs_approval else "worker"

        return {
            "execution_plan": plan,
            "touched_files": touched_files,
            "plan_pending_approval": needs_approval,
            "current_node": node_name,
            "next_node": next_node,
            "node_traces": [trace],
        }

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
