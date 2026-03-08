"""FormatRewriterNode — presentation-only rewriting via few-shot exemplars.

Receives plain prose from the compiler and reformats it for readability:
tables for comparisons, mermaid diagrams for flows, numbered lists for
procedures, bullet lists for feature sets.  Content is never added or
removed — only restructured.

Design based on DECO-G (arXiv:2510.03595): decouple formatting from
task-solving so neither degrades the other.  Few-shot exemplars teach the
target aesthetic by example rather than an ever-growing list of rules.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

import yaml
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..config import settings
from ..llm_telemetry import get_llm_http_client
from ..state import NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.format_rewriter")

_EXEMPLARS_PATH = Path(__file__).resolve().parent.parent / "format_exemplars.yaml"

_REWRITER_SYSTEM = """\
You are a Markdown formatter. You receive a plain-prose response and \
reformat it for readability. You must NOT change, add, or remove any \
meaning — only restructure the presentation.

When to use each format:
- TABLE: when comparing options, models, tools, or alternatives side-by-side.
- MERMAID DIAGRAM: when describing a request flow, pipeline, or architecture.
- NUMBERED LIST: when describing ordered steps or a procedure.
- BULLET LIST: when listing features, properties, or unordered items.
- PROSE: when explaining reasoning, tradeoffs, or narrative analysis.
- CODE BLOCK: when showing commands, config snippets, or file paths.

Preserve all section headings. Use inline code backticks for tool and \
command names. Do not bold keywords to signal coverage. Keep the tone \
conversational — a senior engineer talking to a peer.

Output the reformatted markdown. Nothing else.
"""


def _load_exemplars() -> list[dict[str, str]]:
    """Load golden before/after pairs from the YAML exemplar file."""
    try:
        with open(_EXEMPLARS_PATH) as f:
            data = yaml.safe_load(f)
        if isinstance(data, list):
            return data
    except Exception as e:
        logger.warning("format_exemplars_load_failed: %s", e)
    return []


_exemplar_cache: list[dict[str, str]] | None = None


def _get_exemplars() -> list[dict[str, str]]:
    global _exemplar_cache
    if _exemplar_cache is None:
        _exemplar_cache = _load_exemplars()
    return _exemplar_cache


def _build_few_shot_messages() -> list[SystemMessage | HumanMessage | AIMessage]:
    """Build the few-shot message sequence from exemplars."""
    messages: list[SystemMessage | HumanMessage | AIMessage] = [
        SystemMessage(content=_REWRITER_SYSTEM),
    ]
    for ex in _get_exemplars():
        inp = ex.get("input", "").strip()
        out = ex.get("output", "").strip()
        if inp and out:
            messages.append(HumanMessage(content=inp))
            messages.append(AIMessage(content=out))
    return messages


async def format_rewriter_node(state: dict[str, Any]) -> dict[str, Any]:
    """Reformat compiler output for readability using few-shot exemplars."""
    start = time.monotonic()
    node_name = "format_rewriter"

    compiled = state.get("compiled_answer", "")
    if not compiled or len(compiled.strip()) < 100:
        return {
            "formatted_answer": compiled,
            "current_node": node_name,
        }

    writer_url = settings.writer_model_url or settings.executor_model_url
    writer_name = settings.writer_model_name or settings.executor_model_name

    # Budget: formatting can expand content (tables, diagrams) but not drastically.
    # Cap at input token estimate + 40%.
    input_token_est = len(compiled) // 4
    format_budget = max(2048, min(int(input_token_est * 1.4), 8192))

    try:
        llm = ChatOpenAI(
            base_url=writer_url,
            api_key="not-needed",
            model=writer_name,
            temperature=0.1,
            max_completion_tokens=format_budget,
            streaming=False,
            use_responses_api=False,
            model_kwargs={"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}},
            http_client=get_llm_http_client(),
        )

        messages = _build_few_shot_messages()
        messages.append(HumanMessage(content=compiled))

        result = await llm.ainvoke(messages)
        formatted = result.content.strip()

        if not formatted or len(formatted) < 50:
            logger.warning("format_rewriter_output_too_short")
            formatted = compiled

        latency = (time.monotonic() - start) * 1000
        logger.info(
            "format_rewriter_complete",
            extra={
                "input_len": len(compiled),
                "output_len": len(formatted),
                "budget": format_budget,
                "latency_ms": round(latency),
            },
        )

        return {
            "formatted_answer": formatted,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"Reformatted {len(compiled)} -> {len(formatted)} chars",
                    confidence=0.9,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=latency,
                )
            ],
        }

    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.warning("format_rewriter_failed", exc_info=True)
        return {
            "formatted_answer": compiled,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"Format rewrite failed, passing through: {e}",
                    confidence=0.0,
                    outcome=NodeOutcome.ERROR,
                    latency_ms=latency,
                )
            ],
        }
