"""FinalAnswerCompilerNode — write polished user-facing prose from DecisionRecord only.

This node receives ONLY the DecisionRecord (structured JSON) and produces
the final markdown response.  It has NO access to raw section text, planning
artifacts, critic prose, or chain-of-thought.  This hard boundary prevents
internal reasoning from leaking into user-facing output.
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
from ..state import NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.final_answer_compiler")

_COMPILER_SYSTEM = """\
You are the Final Answer Writer. You receive a structured DecisionRecord \
and produce a well-formatted markdown response for the user.

CONTENT RULES:
1. Answer the main question FIRST in the opening paragraph.
2. Satisfy explicit requirements in the order they appear.
3. COMMIT to one choice per decision point. Present the chosen approach \
   with reasoning; mention rejected alternatives only to explain why \
   the chosen path won.
4. Weave evidence naturally into prose for grounded claims.
5. Label assumptions inline only when materially relevant.
6. Qualify unsupported claims with "roughly" / "approximately" or omit.
7. Include risks only when they have real mitigation value.
8. No internal scaffolding, reasoning traces, or self-narration.

FORMATTING — pick the right element for the content:
- TABLE (pipe syntax with header row) when comparing options, models, \
  tools, or alternatives side-by-side.
- NUMBERED LIST when describing ordered steps or a procedure.
- BULLET LIST when listing features, properties, or unordered items.
- CODE BLOCK (```lang) when showing commands, config, or file paths.
- PROSE when explaining reasoning, tradeoffs, or narrative analysis.
- Use inline `backticks` for tool, command, and model names.
- Do NOT bold keywords just to signal coverage.

VERBOSITY (from style_contract.verbosity_target):
- "terse": 300-600 words.
- "moderate": 800-2000 words.
- "thorough": 2000-4000 words with multi-paragraph sections.

OUTPUT: Markdown with section headings. No JSON wrapper.
"""


async def final_answer_compiler_node(state: dict[str, Any]) -> dict[str, Any]:
    """Compile polished prose from the DecisionRecord."""
    start = time.monotonic()
    node_name = "final_answer_compiler"

    dr_data = state.get("decision_record")
    if not dr_data:
        # Fallback: no DecisionRecord available, pass through raw content
        logger.warning("compiler_no_decision_record")
        return {
            "compiled_answer": state.get("generated_code", ""),
            "current_node": node_name,
        }

    difficulty = state.get("difficulty", 0.5)
    writer_budget = settings.scaled_writer_budget(difficulty)
    writer_budget = max(2048, min(writer_budget, 8192))

    writer_url = settings.writer_model_url or settings.executor_model_url
    writer_name = settings.writer_model_name or settings.executor_model_name

    dr_json = json.dumps(dr_data, indent=2, default=str)

    user_msg = f"DecisionRecord:\n{dr_json}"

    try:
        llm = ChatOpenAI(
            base_url=writer_url,
            api_key="not-needed",
            model=writer_name,
            temperature=0.3,
            max_completion_tokens=writer_budget,
            streaming=False,
            use_responses_api=False,
            model_kwargs={"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}},
            http_client=get_llm_http_client(),
        )

        result = await llm.ainvoke([
            SystemMessage(content=_COMPILER_SYSTEM),
            HumanMessage(content=user_msg),
        ])

        compiled = result.content.strip()
        if not compiled or len(compiled) < 50:
            logger.warning("compiler_output_too_short")
            compiled = state.get("generated_code", "")

        latency = (time.monotonic() - start) * 1000
        logger.info(
            "compiler_complete",
            extra={
                "output_len": len(compiled),
                "dr_len": len(dr_json),
                "latency_ms": round(latency),
            },
        )

        return {
            "compiled_answer": compiled,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"Compiled {len(compiled)} chars from DecisionRecord ({len(dr_json)} chars)",
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
            "compiled_answer": state.get("generated_code", ""),
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
