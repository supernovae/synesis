"""Planner node -- atomic task decomposition (models.yaml: router role).

Breaks complex tasks into small, verifiable steps with file manifests.
Domain-specific decomposition rules come from taxonomy plugins.
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
You are the Planner. Break the task into atomic, verifiable steps. You do NOT write code.

Rules:
- One step = max 3 files. Every step MUST have a verification_command.
- Build incrementally: step N verifies before step N+1 starts.

Reply with JSON:
{"plan":{"steps":[{"id":1,"action":"...","dependencies":[],"files":["file.py"],"verification_command":"python file.py"}],"open_questions":[],"assumptions":[]},"touched_files":["file.py"],"reasoning":"Brief","confidence":0.0-1.0}

Keep plans concise. 1-3 steps for simple tasks; more for complex.
"""

KNOWLEDGE_PLANNER_PROMPT = """\
You are the Planner. Create a structured outline for a comprehensive, in-depth response. You do NOT write the response itself.

Reply with JSON only:
{"plan":{"steps":[{"id":1,"action":"Section: title — concrete deliverable description","dependencies":[]}],"open_questions":[],"assumptions":[]},"reasoning":"Brief","confidence":0.0-1.0}

Rules:
- Each step = one section of the final response. Each section will be written as a substantial standalone deliverable.
- Map the user's explicitly requested sections to steps. Do NOT invent sections they did not ask for.
- CRITICAL: Count the user's explicitly numbered or bulleted deliverables. Create one step per deliverable. Do NOT merge multiple deliverables into a single step. If the user requests N sections, produce at least N steps.
- Each step's action MUST state the concrete deliverable, not just the topic. Bad: "Design Goals — what to cover". Good: "Design Goals — state 3-5 prioritized goals with justification, explicit non-goals, and how each maps to stated constraints."
- If the user listed numbered deliverables, preserve their order and wording.
- Final step should cover risks, caveats, or failure modes if relevant (unless the user already listed this as a deliverable).
- If the user specifies output constraints (e.g., "separate facts from assumptions," "make tradeoffs explicit," "be concise but specific"), capture EACH as a separate item in "assumptions" prefixed with "User format constraints: ..."
- If the user says "do not give a generic answer" or similar, add to assumptions: "User format constraints: choose concrete approaches, do not list alternatives without recommending one."
- If the user specifies a timeline or budget constraint, add: "User format constraints: constrain scope to stated timeline/budget. Defer out-of-scope items to future phases."
"""

planner_llm = ChatOpenAI(
    base_url=settings.planner_model_url,
    api_key="not-needed",
    model=settings.planner_model_name,
    temperature=0.2,
    max_completion_tokens=1024,
    streaming=True,
    use_responses_api=False,
    http_client=get_llm_http_client(uds_path=settings.planner_model_uds or None),
    model_kwargs={"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}},
)


def _build_context_block(rag_context: list[str]) -> str:
    if not rag_context:
        return ""
    joined = "\n---\n".join(rag_context[:5])
    return f"\n\n## Reference (from RAG)\nRelevant context:\n{joined}"


async def planner_node(state: dict[str, Any]) -> dict[str, Any]:
    start = time.monotonic()
    node_name = "planner"

    # Short-circuit: is_code_task=False (explanation-only) WITHOUT plan_required (taxonomy didn't request structured bullets)
    if not state.get("is_code_task", False) and not state.get("plan_required"):
        latency = (time.monotonic() - start) * 1000
        is_code_task = state.get("is_code_task", False)
        logger.info(
            "planner_skipped_text_mode",
            extra={"label": "code" if is_code_task else "text", "latency_ms": latency},
        )
        return {
            "execution_plan": {
                "steps": [
                    {
                        "id": 1,
                        "action": "Produce document/plan",
                        "dependencies": [],
                        "files": [],
                        "verification_command": "",
                    }
                ],
                "open_questions": [],
                "assumptions": [],
            },
            "touched_files": [],
            "plan_pending_approval": False,
            "is_code_task": False,
            "allowed_tools": ["none"],
            "target_language": "markdown",
            "current_node": node_name,
            "next_node": "worker",
            "node_traces": [],
        }

    try:
        task_desc = state.get("task_description", "")
        is_code_task = state.get("is_code_task", False)
        target_lang = state.get("target_language") or ("python" if is_code_task else "markdown")
        from ..context_resolver import get_resolved_rag_context

        rag_context = get_resolved_rag_context(state)
        assumptions = state.get("assumptions", [])
        if isinstance(assumptions, list):
            assumptions_str = ", ".join(assumptions) if assumptions else "None stated"
        else:
            assumptions_str = str(assumptions)

        context_block = _build_context_block(rag_context)

        # Domain-specific decomposition rules (Sovereign alignment)
        from ..taxonomy_prompt_factory import (
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

        # Taxonomy-Driven Contextual Injection: append depth/required_elements from taxonomy_metadata
        from ..taxonomy_prompt_factory import get_planner_system_prompt_append

        taxonomy_append = get_planner_system_prompt_append(state.get("taxonomy_metadata") or {})
        is_code_task = state.get("is_code_task", False)
        base_prompt = KNOWLEDGE_PLANNER_PROMPT if not is_code_task else PLANNER_SYSTEM_PROMPT
        system_prompt = base_prompt + taxonomy_append

        if is_code_task:
            prompt = (
                f"## Task\nLanguage: {target_lang}\n{task_desc}\n"
                f"## Supervisor assumptions\n{assumptions_str}"
                f"{context_block}{domain_rules_block}\n\n"
                f"Produce a structured execution plan for the Executor to follow."
            )
        else:
            prompt = (
                f"## Task\n{task_desc}\n"
                f"{context_block}{domain_rules_block}\n\n"
                f"Produce a structured outline of sections for the response."
            )

        messages = [
            SystemMessage(content=system_prompt),
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
        plan_session = state.get("plan_session", False)
        plan_required = state.get("plan_required", True)
        needs_approval = (plan_session and len(steps) > 0) or (
            plan_required and settings.require_plan_approval and len(steps) > 0
        )

        # Text mode: skip approval unless explicit plan_session
        if needs_approval and not state.get("is_code_task", False) and not plan_session:
            needs_approval = False
            logger.info(
                "planner_skip_approval_text_mode",
                extra={"label": "code" if state.get("is_code_task", False) else "text"},
            )

        next_node = "respond" if needs_approval else "worker"

        out: dict[str, Any] = {
            "execution_plan": plan,
            "touched_files": touched_files,
            "plan_pending_approval": needs_approval,
            "current_node": node_name,
            "next_node": next_node,
            "node_traces": [trace],
        }
        if not needs_approval and not state.get("is_code_task", False):
            out["is_code_task"] = False
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
