"""Worker node -- code generation powered by Qwen 2.5 Coder 32B.

Receives the task + RAG context from state, generates code with
inline reasoning, and returns results for the Critic to evaluate.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..config import settings
from ..state import NodeOutcome, NodeTrace
from ..web_search import format_search_results, search_client

logger = logging.getLogger("synesis.worker")

WORKER_SYSTEM_PROMPT = """\
You are a senior software engineer in a Safety-II system called Synesis.
You generate clean, safe, production-quality code.

RULES:
1. Follow the style guides and best practices from the provided reference material.
2. Always handle errors explicitly. For bash: use set -euo pipefail.
3. Include clear comments only where the intent is non-obvious.
4. Prefer defensive patterns: validate inputs, quote variables, check return codes.
5. Think about edge cases before writing code.

You MUST respond with valid JSON:
{
  "code": "the generated code",
  "explanation": "brief explanation of approach and key decisions",
  "reasoning": "your step-by-step reasoning",
  "assumptions": ["list of assumptions you made"],
  "confidence": 0.0 to 1.0,
  "edge_cases_considered": ["list of edge cases you thought about"]
}
"""

worker_llm = ChatOpenAI(
    base_url=settings.coder_model_url,
    api_key="not-needed",
    model=settings.coder_model_name,
    temperature=0.2,
    max_tokens=4096,
)


def _build_execution_feedback(execution_result: str, iteration: int) -> str:
    """Format sandbox execution results into a prompt section for revision."""
    import json

    try:
        result = json.loads(execution_result)
    except (json.JSONDecodeError, TypeError):
        return f"\n\n## Execution Feedback (iteration {iteration})\n{execution_result}"

    parts = [f"\n\n## Execution Feedback (iteration {iteration})"]

    lint = result.get("lint", {})
    if isinstance(lint, dict) and not lint.get("passed", True):
        parts.append(f"**Lint errors:**\n```\n{lint.get('output', 'unknown')}\n```")

    security = result.get("security", {})
    if isinstance(security, dict) and not security.get("passed", True):
        sec_output = security.get("output", {})
        parts.append(f"**Security issues:**\n```\n{json.dumps(sec_output, indent=2)[:2048]}\n```")

    execution = result.get("execution", {})
    if isinstance(execution, dict) and execution.get("exit_code", 0) != 0:
        parts.append(f"**Runtime error (exit {execution.get('exit_code')}):**\n```\n{execution.get('output', '')}\n```")

    parts.append("Fix ALL issues listed above in your revised code.")
    return "\n".join(parts)


def _build_failure_hints(failure_context: list[str]) -> str:
    """Format past failure patterns into guidance for the worker."""
    if not failure_context:
        return ""
    hints = "\n".join(f"- {ctx}" for ctx in failure_context[:5])
    return f"\n\n## Known Failure Patterns\nThese similar tasks have failed before. Avoid these pitfalls:\n{hints}"


def _build_lsp_diagnostics_block(lsp_diagnostics: list[str]) -> str:
    """Format LSP deep analysis diagnostics into a prompt section."""
    if not lsp_diagnostics:
        return ""
    diags = "\n".join(lsp_diagnostics[:30])
    return (
        f"\n\n## LSP Type Analysis\n"
        f"Deep analysis found the following type errors and symbol issues "
        f"that basic linting missed. Fix ALL of these:\n```\n{diags}\n```"
    )


def _build_web_search_block(web_search_results: list[str]) -> str:
    """Format web search results into a prompt section."""
    if not web_search_results:
        return ""
    lines = "\n".join(f"- {r}" for r in web_search_results[:8])
    return f"\n\n## Web Search Context\nRelevant information from the web:\n{lines}"


def _extract_error_for_search(execution_result: str) -> str:
    """Extract the key error message from execution results for web search."""
    import json

    try:
        result = json.loads(execution_result)
    except (json.JSONDecodeError, TypeError):
        lines = execution_result.strip().splitlines()
        for line in reversed(lines):
            stripped = line.strip()
            if stripped and len(stripped) > 10:
                return stripped[:200]
        return execution_result[:200]

    for section in ("execution", "lint", "security"):
        data = result.get(section, {})
        if isinstance(data, dict):
            if section == "execution" and data.get("exit_code", 0) != 0:
                return data.get("output", "")[:200].strip()
            if section in ("lint", "security") and not data.get("passed", True):
                return str(data.get("output", ""))[:200].strip()

    return ""


def _build_context_block(rag_context: list[str]) -> str:
    if not rag_context:
        return ""
    joined = "\n---\n".join(rag_context)
    return f"\n\n## Reference Material (from RAG)\nUse these style guides and best practices:\n\n{joined}"


async def worker_node(state: dict[str, Any]) -> dict[str, Any]:
    start = time.monotonic()
    node_name = "worker"

    try:
        task_desc = state.get("task_description", "")
        target_lang = state.get("target_language", "bash")
        rag_context = state.get("rag_context", [])
        critic_feedback = state.get("critic_feedback", "")
        iteration = state.get("iteration_count", 0)

        execution_result = state.get("execution_result", "")
        failure_context = state.get("failure_context", [])
        lsp_diagnostics = state.get("lsp_diagnostics", [])
        web_search_results = state.get("web_search_results", [])

        context_block = _build_context_block(rag_context)

        revision_note = ""
        if iteration > 0 and critic_feedback:
            revision_note = (
                f"\n\n## Revision Required (iteration {iteration})\n"
                f"The safety critic flagged these concerns:\n{critic_feedback}\n"
                f"Address each concern in your revised code."
            )

        execution_feedback = ""
        if iteration > 0 and execution_result:
            execution_feedback = _build_execution_feedback(execution_result, iteration)

        # On revision with execution failure, search for error resolution
        if (
            iteration > 0
            and execution_result
            and settings.web_search_enabled
            and settings.web_search_worker_error_enabled
        ):
            error_msg = _extract_error_for_search(execution_result)
            if error_msg:
                search_query = f"{error_msg} {target_lang}"
                results = await search_client.search(search_query, profile="code")
                new_results = format_search_results(results)
                if new_results:
                    web_search_results = list(web_search_results) + new_results
                    logger.info(
                        "worker_error_web_search",
                        extra={
                            "query": search_query[:120],
                            "results_count": len(new_results),
                            "iteration": iteration,
                        },
                    )

        failure_hints = ""
        if failure_context:
            failure_hints = _build_failure_hints(failure_context)

        lsp_block = ""
        if iteration > 0 and lsp_diagnostics:
            lsp_block = _build_lsp_diagnostics_block(lsp_diagnostics)

        web_block = _build_web_search_block(web_search_results)

        previous_code = ""
        if iteration > 0 and state.get("generated_code"):
            previous_code = f"\n\n## Previous Code (needs revision)\n```{target_lang}\n{state['generated_code']}\n```"

        prompt = (
            f"## Task\nLanguage: {target_lang}\n{task_desc}"
            f"{context_block}{web_block}{failure_hints}{previous_code}"
            f"{revision_note}{execution_feedback}{lsp_block}"
        )

        messages = [
            SystemMessage(content=WORKER_SYSTEM_PROMPT),
            HumanMessage(content=prompt),
        ]

        response = await worker_llm.ainvoke(messages)

        import json

        try:
            parsed = json.loads(response.content)
        except json.JSONDecodeError:
            content = response.content
            json_start = content.find("{")
            json_end = content.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                parsed = json.loads(content[json_start:json_end])
            else:
                parsed = {
                    "code": content,
                    "explanation": "Raw response (JSON parse failed)",
                    "reasoning": "Model returned non-JSON",
                    "assumptions": [],
                    "confidence": 0.3,
                }

        latency = (time.monotonic() - start) * 1000
        trace = NodeTrace(
            node_name=node_name,
            reasoning=parsed.get("reasoning", ""),
            assumptions=parsed.get("assumptions", []),
            confidence=parsed.get("confidence", 0.5),
            outcome=NodeOutcome.SUCCESS,
            latency_ms=latency,
            tokens_used=response.usage_metadata.get("total_tokens", 0) if response.usage_metadata else 0,
        )

        logger.info(
            "worker_completed",
            extra={
                "confidence": parsed.get("confidence"),
                "iteration": iteration,
                "code_length": len(parsed.get("code", "")),
                "latency_ms": latency,
            },
        )

        return {
            "generated_code": parsed.get("code", ""),
            "code_explanation": parsed.get("explanation", ""),
            "current_node": node_name,
            "next_node": "critic",
            "node_traces": [trace],
        }

    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.exception("worker_error")
        trace = NodeTrace(
            node_name=node_name,
            reasoning=f"Error: {e}",
            assumptions=[],
            confidence=0.0,
            outcome=NodeOutcome.ERROR,
            latency_ms=latency,
        )
        return {
            "current_node": node_name,
            "next_node": "respond",
            "error": str(e),
            "node_traces": [trace],
        }
