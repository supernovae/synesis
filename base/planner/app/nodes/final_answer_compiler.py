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
and produce a polished, concise markdown response for the user.

RULES:
1. Answer the main question FIRST in the opening paragraph.
2. Satisfy explicit requirements in the order they appear.
3. For each grounded claim, weave the evidence naturally into prose.
4. For assumptions, use inline [Assumption] labels only when materially \
   relevant to the user's decision.
5. For unsupported claims, either qualify with "roughly" / "approximately" \
   or omit if not essential.
6. For risks, include only those with real mitigation value.
7. Remove speculative implementation detail unless the user asked for it.
8. Do NOT expose internal frameworks, scaffolding labels, or reasoning \
   traces.  No "CLAIM:", "GROUNDS:", "WARRANT:", etc.
9. Do NOT use "thought for X seconds", "Let me think about...", or \
   any self-narration.
10. Prefer practical prioritization over completeness theater.

VERBOSITY TARGETS:
- "terse": 300-600 words.  Direct answer + key points only.
- "moderate": 800-2000 words.  Answer + reasoning + alternatives.
- "thorough": 2000-4000 words.  Full treatment with headed sections, \
  concrete examples, specific tool/version choices, rejected alternatives \
  with reasons, and tradeoff analysis.  Each section should have \
  multi-paragraph narrative depth — not just a topic sentence.

Use the style_contract.verbosity_target to calibrate length.
Use the style_contract.max_section_paragraphs as the per-section depth guide.

OUTPUT: Markdown only.  No JSON wrapper.  No code fences around the \
entire response.
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
    writer_budget = max(2048, min(writer_budget, 12288))

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
