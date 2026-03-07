"""Worker node -- code generation and explanation (models.yaml: general role).

Receives task + RAG context (+ optional execution_plan from Planner) and produces
markdown output. Code tasks include fenced code blocks; explanations are plain markdown.
All output streams natively through the OpenAI SDK. Taxonomy steering (tone, depth,
required_elements) and difficulty-based token budgets provide differentiation.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..code_extractor import (
    detect_needs_input,
    detect_stop_reason,
    extract_files_touched,
    extract_patch_ops,
    extract_primary_code,
)
from ..config import settings
from ..llm_telemetry import get_llm_http_client
from ..state import NodeOutcome, NodeTrace
from ..web_search import format_search_results, search_client

logger = logging.getLogger("synesis.worker")

# ── Universal worker prompt ──
# Produces markdown for ALL tasks. Code uses fenced blocks; explanations use prose.
# Taxonomy steering (tone, depth, required_elements) and the difficulty-based token
# budget provide all differentiation — no EASY/MEDIUM/HARD tiers needed.
WORKER_PROMPT = """\
You are a helpful assistant. Respond directly in markdown.

For coding tasks:
- Produce clean, correct code in fenced code blocks with language tags.
- For multiple files, add the file path after the tag: ```python:path/to/file.py
- Handle errors explicitly (for bash: set -euo pipefail).
- Include run commands where relevant.
- Comments only where intent is non-obvious.

For explanations and discussions:
- Use headings, lists, and clear structure.
- No code blocks unless the user explicitly asks.

If you cannot proceed (missing info, blocked dependency, safety concern), say so clearly.
Be concise. Adjust depth to match the task complexity.
"""

_TEXT_SUFFIX = """

Respond directly in markdown. Use headings, lists, and structure for clarity.
Be concise and clear. No code blocks unless the user explicitly asks.
If you are not confident about a specific fact, say so briefly. Do not invent citations.
"""

_DEEP_DIVE_SUFFIX = """

DEPTH RULES — this is a detailed analysis, not a summary:
- Each section in the execution plan is a substantial deliverable. Write each section as if it were a standalone document with real depth.
- Do NOT compress the response into a brief overview. The user expects thorough, multi-paragraph coverage per section.
- The planner outlined sections based on the user's explicit requests. Cover EVERY section. Do not merge or skip any.
- If the user asked for specific sections or structure, follow their outline exactly.

SPECIFICITY RULES:
- Choose one concrete approach and justify it. Do not list "X or Y" alternatives without recommending one. For each major choice, state one rejected alternative and why you rejected it.
- If you name a technology, state in one sentence why it beats alternatives for this specific use case.
- Be specific: name tools, versions, and quantities. Avoid abstract categories.
- When discussing model sizes, infrastructure, or cost, give concrete tiers with justification, not vague labels.

CONSTRAINT ADHERENCE:
- Address the user's stated constraints directly. Do not add requirements they did not mention.
- When a timeline or budget constraint is stated, ruthlessly prioritize. Name only what fits. Defer everything else to "Future Work" or "Phase 2+."
- Do not propose a stack that a small team cannot deliver in the stated timeframe.

HONESTY AND RIGOR:
- Separate facts (what you know) from assumptions (what you infer) from recommendations (what you advise). Use explicit labels if the user asked for this.
- When you lack specific data (exact latency, pricing, version compatibility), say so. Do not invent plausible-sounding numbers or thresholds.
- Flag assumptions with [Assumption] inline. Flag uncertain claims with [Uncertain] inline.
"""


def _build_text_prompt_with_tone(tone: str) -> str:
    """Build a system prompt with a domain-specific tone preamble."""
    return f"{tone}{_TEXT_SUFFIX}"


worker_llm = ChatOpenAI(
    base_url=settings.executor_model_url,
    api_key="not-needed",
    model=settings.executor_model_name,
    temperature=0.2,
    max_completion_tokens=4096,
    streaming=True,
    use_responses_api=False,
    http_client=get_llm_http_client(uds_path=settings.executor_model_uds or None),
    model_kwargs={"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}},
)


def _format_lint_output(raw: str) -> str:
    """Convert linter JSON output to human-readable file:line:col: message format.

    Supports Ruff (Python), Shellcheck (bash), and ESLint (JS/TS). Falls back to raw
    for other formats (e.g. cppcheck text, javac).
    """
    import json
    import os

    raw = (raw or "").strip()
    if not raw:
        return raw
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return raw

    lines: list[str] = []

    # Ruff: array of {filename, location: {row, column}, message, code}
    # Shellcheck legacy -f json: array of {file, line, column, message, code}
    if isinstance(parsed, list):
        for d in parsed:
            if not isinstance(d, dict):
                continue
            path = d.get("filename") or d.get("file", "")
            if path:
                path = os.path.basename(path)
            loc = d.get("location") if isinstance(d.get("location"), dict) else {}
            row = (loc.get("row") if loc else None) or d.get("line", 0)
            col = (loc.get("column") if loc else None) or d.get("column", 0)
            msg = d.get("message", "error")
            code = d.get("code", "")
            if isinstance(code, int):
                code = f"SC{code}" if code else ""
            if code:
                lines.append(f"{path}:{row}:{col}: {msg} ({code})")
            else:
                lines.append(f"{path}:{row}:{col}: {msg}")

    # Shellcheck json1: {comments: [{file, line, column, message, code}]}
    elif isinstance(parsed, dict) and "comments" in parsed:
        for c in parsed.get("comments", []):
            if not isinstance(c, dict):
                continue
            path = os.path.basename(c.get("file", ""))
            row = c.get("line", 0)
            col = c.get("column", 0)
            msg = c.get("message", "error")
            code = c.get("code", "")
            if code:
                lines.append(f"{path}:{row}:{col}: {msg} (SC{code})")
            else:
                lines.append(f"{path}:{row}:{col}: {msg}")

    # ESLint: {filePath, messages: [{line, column, message, ruleId}]} or array of those
    elif isinstance(parsed, dict) and "messages" in parsed:
        path = os.path.basename(parsed.get("filePath", ""))
        for m in parsed.get("messages", []):
            if not isinstance(m, dict):
                continue
            row = m.get("line", 0)
            col = m.get("column", 0)
            msg = m.get("message", "error")
            code = m.get("ruleId", "")
            if code:
                lines.append(f"{path}:{row}:{col}: {msg} ({code})")
            else:
                lines.append(f"{path}:{row}:{col}: {msg}")
    elif isinstance(parsed, list) and parsed and isinstance(parsed[0], dict) and "messages" in parsed[0]:
        for item in parsed:
            path = os.path.basename(item.get("filePath", ""))
            for m in item.get("messages", []) or []:
                if not isinstance(m, dict):
                    continue
                row = m.get("line", 0)
                col = m.get("column", 0)
                msg = m.get("message", "error")
                code = m.get("ruleId", "")
                if code:
                    lines.append(f"{path}:{row}:{col}: {msg} ({code})")
                else:
                    lines.append(f"{path}:{row}:{col}: {msg}")

    return "\n".join(lines) if lines else raw


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
        raw_lint = lint.get("output", "unknown")
        formatted = _format_lint_output(raw_lint)
        parts.append(f"**Lint errors:**\n```\n{formatted}\n```")

    security = result.get("security", {})
    if isinstance(security, dict) and not security.get("passed", True):
        sec_output = security.get("output", {})
        parts.append(f"**Security issues:**\n```\n{json.dumps(sec_output, indent=2)[:2048]}\n```")

    execution = result.get("execution", {})
    if isinstance(execution, dict) and execution.get("exit_code", 0) != 0:
        parts.append(f"**Runtime error (exit {execution.get('exit_code')}):**\n```\n{execution.get('output', '')}\n```")

    # Handle parse/sandbox errors: top-level error, stdout, stderr when no structured detail
    if len(parts) == 1:  # Only header, no lint/security/execution blocks
        top_err = result.get("error", "")
        top_stdout = result.get("stdout", "")
        top_stderr = result.get("stderr", "")
        if top_err or top_stdout or top_stderr:
            if top_err:
                parts.append(f"**Sandbox/parse error:**\n```\n{top_err}\n```")
            if top_stderr:
                parts.append(f"**stderr:**\n```\n{top_stderr[:1024]}\n```")
            if top_stdout and not top_err:
                parts.append(f"**stdout:**\n```\n{top_stdout[:1024]}\n```")

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


def _build_pinned_block(pinned: list) -> str:
    """Build prefix-aware block from context_pack.pinned (Tier 1–4). See docs/performance.md."""
    if not pinned:
        return ""
    texts: list[str] = []
    for ch in pinned:
        t = ch.get("text", "") if isinstance(ch, dict) else getattr(ch, "text", "")
        if t and isinstance(t, str):
            texts.append(t.strip())
    if not texts:
        return ""
    joined = "\n---\n".join(texts)
    return f"\n\n## Pinned Context (Policy, Standards, Manifest)\n{joined}\n"


def _build_context_block(rag_context: list[str]) -> str:
    if not rag_context:
        return ""
    joined = "\n---\n".join(rag_context)
    return f"\n\n## Reference Material (from RAG)\nUse these style guides and best practices:\n\n{joined}"


async def worker_node(state: dict[str, Any]) -> dict[str, Any]:
    start = time.monotonic()
    node_name = "worker"

    try:
        token_budget = state.get("token_budget_remaining", settings.max_tokens_per_request)
        if settings.max_executor_tokens > 0:
            token_budget = min(token_budget, settings.max_executor_tokens)
        if token_budget <= 0:
            return {
                "current_node": node_name,
                "next_node": "respond",
                "error": "Token budget exhausted. Partial result may be available.",
                "node_traces": [
                    NodeTrace(
                        node_name=node_name,
                        reasoning="Budget limit reached",
                        confidence=0.0,
                        outcome=NodeOutcome.ERROR,
                        latency_ms=0,
                    )
                ],
            }

        task_desc = (state.get("task_description", "") or "").strip()
        if not task_desc:
            # Fallback: derive from last user message (avoids "I need more info" on trivial)
            for m in reversed(state.get("messages", []) or []):
                c = (
                    getattr(m, "content", None)
                    if hasattr(m, "content")
                    else (m.get("content") if isinstance(m, dict) else None)
                )
                if c and isinstance(c, str) and c.strip():
                    task_desc = c.strip()[:500]
                    break
            if not task_desc:
                task_desc = (state.get("last_user_content", "") or "").strip()[:500]
            if not task_desc:
                # Last resort: extract from context_pack session chunk
                pack = state.get("context_pack") or {}
                pack = pack if isinstance(pack, dict) else (pack.model_dump() if hasattr(pack, "model_dump") else {})
                for ch in pack.get("pinned", []) or []:
                    text = ch.get("text", "") if isinstance(ch, dict) else getattr(ch, "text", "")
                    if text and "Current task:" in text:
                        prefix = "Current task:"
                        idx = text.find(prefix)
                        if idx >= 0:
                            task_desc = text[idx + len(prefix) :].strip().split("\n")[0][:500]
                            break
        is_code = state.get("is_code_task", False)
        _lang_default = "python" if is_code else "markdown"
        raw_lang = state.get("target_language") or _lang_default
        target_lang = raw_lang if raw_lang not in ("", "infer") else _lang_default
        from ..context_resolver import get_resolved_rag_context

        rag_context = get_resolved_rag_context(state)
        critic_feedback = state.get("critic_feedback", "")
        iteration = state.get("iteration_count", 0)

        execution_result = state.get("execution_result", "")
        failure_context = state.get("failure_context", [])
        lsp_diagnostics = state.get("lsp_diagnostics", [])
        web_search_results = state.get("web_search_results", [])
        revision_strategy = state.get("revision_strategy", "")
        revision_strategies_tried = state.get("revision_strategies_tried", [])
        revision_constraints = state.get("revision_constraints", {})

        # Prefix-aware order: pinned (Tier1-4) first, then RAG. See docs/performance.md.
        context_pack = state.get("context_pack")
        pack = (
            context_pack
            if isinstance(context_pack, dict)
            else (context_pack.model_dump() if hasattr(context_pack, "model_dump") else {})
        )
        pinned_block = _build_pinned_block(pack.get("pinned", []) or [])
        context_block = _build_context_block(rag_context)

        stages_passed = state.get("stages_passed", [])
        preserve_stages = (revision_constraints or {}).get("preserve_stages", [])
        anchor = (revision_constraints or {}).get("preserve_stages_anchor", "hard")
        failure_type = state.get("failure_type", "runtime")

        # Milestone Status banner (top of prompt)
        # Regress-Reason: enhanced block when refactor strategy OR high iteration (soft anchor)
        milestone_banner = ""
        high_iteration = iteration >= 2  # threshold for constraint degradation
        soft_anchor = anchor == "soft"
        is_refactor_mode = revision_strategy == "refactor" or (high_iteration and soft_anchor)
        if iteration > 0 and (stages_passed or revision_strategy):
            to_preserve = [s for s in (preserve_stages or []) if s in stages_passed]
            stages_str = ", ".join(to_preserve) if to_preserve else "(none)"
            hard_anchor = anchor == "hard"

            if is_refactor_mode:
                # STRATEGY: ARCHITECTURAL REFACTOR (Soft Constraint Mode)
                milestone_banner = (
                    "\n\n### STRATEGY: ARCHITECTURAL REFACTOR (Soft Constraint Mode)\n"
                    "You have moved to a **Refactor** strategy. Your objective is to address the core logic failure, "
                    "even if it requires changing existing structures.\n\n"
                    "#### ⚖️ The Monotonicity Policy:\n"
                    f"The following milestones were previously achieved: {stages_str}.\n"
                    "In **Refactor** mode, these are **Soft Constraints**.\n\n"
                    "#### 🚩 Regression Protocol:\n"
                    "If you determine that a previously passing stage (e.g., Lint or Security) MUST be regressed to implement the fix:\n"
                    "1. **Declare it:** Add the stage name to the `regressions_intended` list.\n"
                    "2. **Justify it:** In `regression_justification`, provide a technical rationale (e.g., "
                    '"Must change function signature in `utils.py`, which will temporarily break type-checking in `main.py` until the second phase of the refactor.").\n'
                    "3. **Minimize it:** Only regress what is absolutely necessary. Avoid collateral damage.\n\n"
                    "#### 🛠️ Worker Output Requirements:\n"
                    "Your JSON response must include:\n"
                    "- `regressions_intended`: Array of stages you are knowingly breaking (if any).\n"
                    "- `regression_justification`: Technical explanation for the Evidence-Gated Critic.\n"
                    "- `patch_ops`: The structural changes required (if multi-file).\n"
                )
            else:
                # Item 5: Escape hatch — allow regressions_intended only when NOT minimal_fix or after 2+ attempts
                escape_allowed = revision_strategy != "minimal_fix" or iteration >= 2
                if hard_anchor and not escape_allowed:
                    instr = "You MUST NOT introduce new errors into the stages listed above."
                elif hard_anchor and escape_allowed:
                    instr = (
                        "Prefer not regressing. If the only valid fix requires regressing a stage, "
                        "you MAY set regressions_intended and regression_justification (required, non-empty)."
                    )
                else:
                    instr = "You are allowed to diverge if structurally necessary, but you MUST provide a 'Rationalization' and set regressions_intended."
                milestone_banner = (
                    "\n\n🚨 MILESTONE STATUS: MONOTONICITY CONSTRAINTS\n"
                    f"Current Strategy: {revision_strategy or 'none'}\n"
                    f"Stages Passed (DO NOT REGRESS): {stages_str}\n"
                    f"Instructions:\n"
                    f"1. Your primary objective is to fix the {failure_type} failure.\n"
                    f"2. {instr}\n"
                    f"3. If a regression is absolutely necessary for a structural fix, state this in your reasoning and set regressions_intended with regression_justification.\n"
                )

        strategy_constraint_block = ""
        if revision_strategy and revision_constraints:
            constraints_str = ", ".join(
                f"{k}={v}" for k, v in revision_constraints.items() if k != "preserve_stages_anchor"
            )
            strategy_constraint_block = (
                f"\n\n## Revision Strategy (use this approach)\n"
                f"Strategy: {revision_strategy}. Constraints: {constraints_str}\n"
                f"Previously tried: {revision_strategies_tried}\n"
                f"Stay within these constraints."
            )

        revision_note = ""
        if iteration > 0 and critic_feedback:
            revision_note = (
                f"\n\n## Revision Required (iteration {iteration})\n"
                f"The safety critic flagged these concerns:\n{critic_feedback}\n"
                f"Address each concern in your revised code."
            )
        # Patch Integrity Gate failure (before sandbox) - no iteration increment
        integrity_feedback = ""
        if state.get("integrity_failure_reason"):
            failure = state.get("integrity_failure")
            remed = critic_feedback
            if failure and isinstance(failure, dict):
                remed = failure.get("remediation", remed)
                ev = failure.get("evidence", "")
                if ev:
                    remed = f"Evidence: {ev}\n{remed}"
            integrity_feedback = (
                f"\n\n## Integrity Check Failed (fix before execution)\n"
                f"Category: {state.get('integrity_failure_reason', 'unknown')}\n"
                f"{remed}\n"
                f"Produce revised code that passes these checks."
            )

        strategy_violation_block = ""
        if state.get("strategy_violation"):
            regressions_declared = state.get("regressions_intended", []) or []
            if regressions_declared:
                strategy_violation_block = (
                    "\n\n## Regression Declared (Critic will evaluate)\n"
                    f"You set regressions_intended={regressions_declared}. "
                    "The Critic will evaluate your regression_justification. If sound, continue. Otherwise revise to avoid the regression."
                )
            else:
                strategy_violation_block = (
                    "\n\n## REGRESSION DETECTED: Monotonicity Violation\n"
                    "You broke a stage (Lint or Security) that was previously passing. "
                    "REVERT to the previous functional structure and apply the fix more surgically. "
                    "Do NOT introduce new failures into stages that had passed."
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

        user_answer_block = ""
        user_answer = state.get("user_answer_to_needs_input", "")
        if user_answer:
            user_answer_block = (
                f"\n\n## User answered your previous question\n"
                f"The user provided: {user_answer}\n"
                f"Incorporate this into your implementation."
            )

        conflict_block = ""
        context_pack = state.get("context_pack")
        if context_pack:
            pack = (
                context_pack
                if isinstance(context_pack, dict)
                else (context_pack.model_dump() if hasattr(context_pack, "model_dump") else {})
            )
            warnings = pack.get("conflict_warnings", [])
            conflicts = pack.get("context_conflicts", [])
            all_items = list(warnings) + list(conflicts)
            if all_items:
                lines = ["\n\n## Conflict Warning (do NOT resolve silently)"]
                for w in warnings:
                    if isinstance(w, dict):
                        trusted = w.get("trusted_claim", "")
                        evidence = w.get("untrusted_evidence", "")
                        sugg = w.get("suggestion", "Flag as blocking_issue.")
                    else:
                        trusted = getattr(w, "trusted_claim", "")
                        evidence = getattr(w, "untrusted_evidence", "")
                        sugg = getattr(w, "suggestion", "Flag as blocking_issue.")
                    lines.append(f"- Trusted says: {trusted}. Repo shows: {evidence}. {sugg}")
                for c in conflicts:
                    if isinstance(c, dict):
                        feat = c.get("feature", "")
                        tval = c.get("trusted_value", "")
                        uval = c.get("untrusted_value", "")
                        res = c.get("resolution", "")
                    else:
                        feat = getattr(c, "feature", "")
                        tval = getattr(c, "trusted_value", "")
                        uval = getattr(c, "untrusted_value", "")
                        res = getattr(c, "resolution", "")
                    lines.append(
                        f"- [ContextConflict] {feat}: Org={tval}, Project={uval}. {res} Include in blocking_issues or reasoning."
                    )
                conflict_block = "\n".join(lines)

        plan_block = ""
        constraints_block = ""
        execution_plan = state.get("execution_plan", {}) or {}
        touched_files = state.get("touched_files", []) or []
        if isinstance(execution_plan, dict):
            steps = execution_plan.get("steps", [])
            if steps:
                plan_lines = ["\n\n## Execution Plan (from Planner) — Atomic steps"]
                for s in steps:
                    act = s.get("action", str(s)) if isinstance(s, dict) else str(s)
                    files = s.get("files", []) if isinstance(s, dict) else []
                    verify = s.get("verification_command", "") if isinstance(s, dict) else ""
                    line = f"- {act}"
                    if files:
                        line += f" [files: {', '.join(files[:3])}]"
                    if verify:
                        line += f" — verify: `{verify}`"
                    plan_lines.append(line)
                plan_block = "\n".join(plan_lines)

            assumptions = execution_plan.get("assumptions", []) or []
            constraint_items = [
                a for a in assumptions
                if isinstance(a, str) and a.lower().startswith("user format constraint")
            ]
            if constraint_items:
                clines = ["\n\n## Response Constraints (from user's explicit requests)"]
                for c in constraint_items:
                    cleaned = c.split(":", 1)[1].strip() if ":" in c else c
                    clines.append(f"- {cleaned}")
                constraints_block = "\n".join(clines)
                logger.debug("worker_format_constraints_injected", extra={"count": len(constraint_items)})

        if len(touched_files) > 1 and state.get("is_code_task", False):
            plan_block += "\n\n## Multi-File Task\nOutput patch_ops for each file: [{path, op, text}]. Leave code empty or use as entry point. The system bundles patches for execution."

        task_is_trivial = state.get("task_is_trivial", False)
        trivial_hint = (
            "\n\n**Trivial task** (Supervisor classified). Produce minimal correct code. "
            "Use sensible defaults. Single file (hello.py) unless include_tests; Include run commands. No questions."
            if task_is_trivial
            else ""
        )
        # Prefix-aware order: [Tier1-4, RAG, Task/History]. See docs/performance.md.
        is_code = state.get("is_code_task", False)
        task_header = (
            f"\n\n## Task\nLanguage: {target_lang}\n{task_desc}{trivial_hint}"
            if is_code
            else f"\n\n## Task\n{task_desc}"
        )
        prompt = (
            f"{pinned_block}"
            f"{context_block}"
            f"{milestone_banner}"
            f"{task_header}"
            f"{plan_block}"
            f"{constraints_block}"
            f"{user_answer_block}"
            f"{conflict_block}"
            f"{web_block}{failure_hints}{previous_code}"
            f"{strategy_constraint_block}"
            f"{integrity_feedback}"
            f"{strategy_violation_block}"
            f"{revision_note}{execution_feedback}{lsp_block}"
        )

        effective_size = state.get("task_size", "medium")

        # Sovereign Persona Injection: append vertical-specific block when active_domain matches
        from ..taxonomy_prompt_factory import (
            get_worker_persona_block,
            resolve_active_vertical,
        )

        active_vertical = resolve_active_vertical(
            active_domain_refs=state.get("active_domain_refs"),
            platform_context=state.get("platform_context"),
        )

        if active_vertical == "lifestyle" and effective_size == "hard":
            effective_size = "medium"
            logger.debug("worker_vertical_override", extra={"vertical": "lifestyle", "effective_size": "medium"})
        if iteration > 0 and effective_size == "easy":
            effective_size = "medium"

        # ── Build system prompt: universal base + taxonomy steering ──
        is_code_task = state.get("is_code_task", False)

        from ..taxonomy_prompt_factory import get_discovery_prompt, get_executor_depth_block, get_worker_explain_tone

        taxonomy_depth = get_executor_depth_block(state.get("taxonomy_metadata") or {})

        if not is_code_task:
            tone = get_worker_explain_tone(state.get("taxonomy_metadata") or {})
            system_prompt = _build_text_prompt_with_tone(tone) if tone else WORKER_PROMPT
            if tone:
                taxonomy_key = (state.get("taxonomy_metadata") or {}).get("taxonomy_key", "")
                logger.info("worker_taxonomy_tone", extra={"taxonomy_key": taxonomy_key})
            if state.get("plan_required"):
                system_prompt += _DEEP_DIVE_SUFFIX
                logger.debug("worker_deep_dive_suffix_injected")
        else:
            system_prompt = WORKER_PROMPT

        vertical_block = get_worker_persona_block(active_vertical, task_desc=task_desc)
        if vertical_block:
            system_prompt = f"{system_prompt}\n\n{vertical_block}"
            logger.debug("worker_vertical_injection", extra={"vertical": active_vertical})
        if taxonomy_depth:
            system_prompt = f"{system_prompt}{taxonomy_depth}"
            logger.debug(
                "worker_taxonomy_depth_injection",
                extra={"taxonomy_key": (state.get("taxonomy_metadata") or {}).get("taxonomy_key", "")},
            )
        if not is_code_task:
            discovery = get_discovery_prompt(state.get("taxonomy_metadata") or {})
            if discovery:
                system_prompt = f"{system_prompt}\n\n{discovery}"
            logger.info("worker_text_mode", extra={"is_code_task": False})

        logger.debug("worker_effective_size=%s", effective_size)

        # ── Token budget: continuous difficulty curve ──
        _MIN_BUDGET = 1024
        _MAX_BUDGET = 8192
        raw_complexity = state.get("complexity_score", 0) or 0
        difficulty = min(1.0, float(raw_complexity) / 50.0)
        token_budget = int(_MIN_BUDGET + (_MAX_BUDGET - _MIN_BUDGET) * difficulty**1.5)
        if not is_code_task:
            floor = 4096 if state.get("plan_required") else 2048
            token_budget = max(token_budget, floor)

        _ACK_WORDS = (
            r"thanks|thank you|thx|ok|okay|got it|cool|great|sure|"
            r"yes|no|yep|nope|bye|cheers|perfect|nice|awesome|lol|haha|"
            r"sounds good|will do|noted|roger|right|alright|all good|fair enough"
        )
        _SOCIAL_ACK_RE = re.compile(
            rf"^({_ACK_WORDS})([,;.!?\s]*({_ACK_WORDS})[,;.!?\s]*)*$",
            re.IGNORECASE,
        )
        if _SOCIAL_ACK_RE.match(task_desc.strip()):
            token_budget = 256
            logger.debug("worker_social_ack_budget", extra={"task": task_desc[:30]})

        task_size = state.get("task_size", "medium")
        logger.debug(
            "worker_token_budget",
            extra={"task_size": task_size, "difficulty": round(difficulty, 3), "budget": token_budget},
        )

        # ── Build multi-turn messages for the LLM ──
        ds_messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
        conv_history = state.get("conversation_history") or []
        for entry in conv_history:
            if not isinstance(entry, str):
                continue
            if entry.startswith("[user]: "):
                ds_messages.append({"role": "user", "content": entry[8:]})
            elif entry.startswith("[assistant]: "):
                ds_messages.append({"role": "assistant", "content": entry[13:]})
            elif entry.startswith("[system]: "):
                ds_messages.append({"role": "system", "content": entry[10:]})
        ds_messages.append({"role": "user", "content": prompt})

        # ── Non-sandbox path: deferred direct stream ──
        # The SSE generator calls the executor via the raw openai SDK,
        # preserving reasoning_content (langchain-ai/langchain#34706).
        if not is_code_task:
            latency = (time.monotonic() - start) * 1000
            trace = NodeTrace(
                node_name=node_name,
                reasoning="Deferred direct stream",
                assumptions=[],
                confidence=0.9,
                outcome=NodeOutcome.SUCCESS,
                latency_ms=latency,
                tokens_used=0,
            )
            logger.info(
                "worker_deferred_stream",
                extra={
                    "task_size": task_size,
                    "token_budget": token_budget,
                    "history_turns": len(conv_history),
                    "latency_ms": latency,
                },
            )
            knowledge_temp = 0.3 if state.get("plan_required") else 0.2
            return {
                "generated_code": "",
                "direct_stream_request": {
                    "messages": ds_messages,
                    "max_completion_tokens": token_budget,
                    "temperature": knowledge_temp,
                    "extra_body": {"chat_template_kwargs": {"enable_thinking": False}},
                },
                "code_explanation": "",
                "files_touched": [],
                "unified_diff": None,
                "patch_ops": [],
                "code_ref": {},
                "regressions_intended": [],
                "regression_justification": "",
                "current_node": node_name,
                "node_traces": [trace],
                "token_budget_remaining": token_budget,
                "task_description": state.get("task_description", ""),
                "failure_ids_seen": state.get("failure_ids_seen", []) or [],
            }

        # ── Sandbox/code path: call LLM, extract code from markdown ──
        # Include recent conversation history so follow-ups like "now add type
        # hints" know what function to modify.  Bounded to last 6 turns to
        # avoid blowing the context window.
        history_messages: list[SystemMessage | HumanMessage | AIMessage] = []
        for entry in conv_history[-6:]:
            if not isinstance(entry, str):
                continue
            if entry.startswith("[user]: "):
                history_messages.append(HumanMessage(content=entry[8:]))
            elif entry.startswith("[assistant]: "):
                history_messages.append(AIMessage(content=entry[13:]))
            elif entry.startswith("[system]: "):
                history_messages.append(SystemMessage(content=entry[10:]))

        messages = [
            SystemMessage(content=system_prompt),
            *history_messages,
            HumanMessage(content=prompt),
        ]
        llm_to_use = worker_llm.bind(max_completion_tokens=token_budget)

        thinking_param = getattr(settings, "executor_thinking_param", "enable_thinking") or ""
        if task_size == "hard" and getattr(settings, "worker_thinking_mode_enabled", True) and thinking_param:
            llm_to_use = llm_to_use.bind(
                extra_body={"chat_template_kwargs": {thinking_param: True}},
                temperature=0.6,
            )
            logger.debug("worker_thinking_mode_enabled", extra={"task_size": task_size, "param": thinking_param})

        response = await llm_to_use.ainvoke(messages)
        content = response.content or ""

        # ── Post-hoc extraction from markdown ──
        needs_input_detected, needs_input_question = detect_needs_input(content)
        stop_reason = detect_stop_reason(content)

        # Scope validation: if Worker mentions files not in touched_files
        out_of_scope: list[str] = []
        planner_files = state.get("touched_files", []) or []
        worker_files = extract_files_touched(content)
        if planner_files and worker_files:
            allowed = {p.rstrip("/") for p in planner_files if p}
            out_of_scope = [p for p in worker_files if p and not any(p == a or p.startswith(a + "/") for a in allowed)]
            if out_of_scope and not stop_reason:
                stop_reason = "needs_scope_expansion"

        tokens_used = response.usage_metadata.get("total_tokens", 0) if response.usage_metadata else 0
        latency = (time.monotonic() - start) * 1000

        if stop_reason:
            trace = NodeTrace(
                node_name=node_name,
                reasoning=f"stop_reason={stop_reason}",
                assumptions=[],
                confidence=0.5,
                outcome=NodeOutcome.SUCCESS,
                latency_ms=latency,
                tokens_used=tokens_used,
            )
            logger.info("worker_stop_reason", extra={"stop_reason": stop_reason})
            next_on_stop = "supervisor" if stop_reason == "needs_scope_expansion" else "respond"
            result: dict[str, Any] = {
                "stop_reason": stop_reason,
                "stop_reason_explanation": content[:200].strip(),
                "scope_expansion_needed": stop_reason == "needs_scope_expansion",
                "current_node": node_name,
                "next_node": next_on_stop,
                "token_budget_remaining": token_budget - tokens_used,
                "node_traces": [trace],
            }
            if stop_reason == "needs_scope_expansion":
                result["requested_files"] = out_of_scope[:10]
                result["scope_expansion_reason"] = content[:200].strip() or "File not in execution plan."
            return result

        if needs_input_detected:
            trace = NodeTrace(
                node_name=node_name,
                reasoning="needs_input detected",
                assumptions=[],
                confidence=0.5,
                outcome=NodeOutcome.SUCCESS,
                latency_ms=latency,
                tokens_used=tokens_used,
            )
            q = needs_input_question or "I need more information to proceed. Can you provide more details?"
            logger.info("executor_needs_input", extra={"question": q[:80]})
            return {
                "needs_input_question": q,
                "current_node": node_name,
                "next_node": "respond",
                "token_budget_remaining": token_budget - tokens_used,
                "node_traces": [trace],
            }

        # Extract code from fenced blocks
        generated_code = extract_primary_code(content, target_lang)
        files_touched = worker_files or []
        if generated_code and not files_touched:
            ext = {
                "python": "py",
                "py": "py",
                "bash": "sh",
                "shell": "sh",
                "sh": "sh",
                "javascript": "js",
                "js": "js",
                "typescript": "ts",
                "ts": "ts",
            }.get((target_lang or "").lower(), "txt")
            files_touched = [f"script.{ext}"]

        patch_ops_list = extract_patch_ops(content)

        trace = NodeTrace(
            node_name=node_name,
            reasoning="markdown output",
            assumptions=[],
            confidence=0.7,
            outcome=NodeOutcome.SUCCESS,
            latency_ms=latency,
            tokens_used=tokens_used,
        )

        logger.info(
            "worker_completed code_len=%d patch_ops=%d",
            len(generated_code),
            len(patch_ops_list),
            extra={"iteration": iteration, "latency_ms": latency},
        )

        updates: dict[str, Any] = {
            "generated_code": generated_code,
            "code_explanation": "",
            "files_touched": files_touched,
            "unified_diff": None,
            "patch_ops": patch_ops_list,
            "code_ref": {},
            "regressions_intended": [],
            "regression_justification": "",
            "current_node": node_name,
            "node_traces": [trace],
            "token_budget_remaining": token_budget - tokens_used,
            "task_description": state.get("task_description", ""),
            "failure_ids_seen": state.get("failure_ids_seen", []) or [],
        }
        if revision_strategy:
            updates["revision_strategies_tried"] = [*revision_strategies_tried, revision_strategy]
        return updates

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
            "files_touched": [],  # §7.2: Worker must always emit files_touched
            "current_node": node_name,
            "next_node": "respond",
            "error": str(e),
            "node_traces": [trace],
        }
