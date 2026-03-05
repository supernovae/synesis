"""Critic node -- evidence-based review (models.yaml: critic role, DeepSeek R1).

Enriches understanding through scenario-based analysis. Blocks only with
concrete evidence (sandbox, LSP, static analysis). Budget Guidance
(arXiv:2506.13752) scales R1 thinking tokens by task difficulty.
"""

from __future__ import annotations

import contextlib
import logging
import re
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..api_metrics import record_critic_rejection
from ..carried_uncertainties import build_universal_carried_uncertainties_signal
from ..config import settings
from ..critic_policy import (
    build_evidence_needed_query_plan,
    check_evidence_gate,
    retry_state_updates,
    should_force_pass,
)
from ..llm_telemetry import get_llm_http_client
from ..rag_client import SYNESIS_CATALOG, discover_collections, retrieve_context
from ..state import NodeOutcome, NodeTrace, WhatIfAnalysis
from ..validator import validate_critic_with_repair
from ..web_search import format_search_results, search_client

logger = logging.getLogger("synesis.critic")

# ── Critic prompts: evidence-gated review ──
# Hard tasks get full analysis; easy/medium get gentle review.
CRITIC_SYSTEM_PROMPT = """\
You are the Critic. Evidence-based analysis only. Never block without proof.

EVIDENCE GATE: If approved=false, every blocking_issue MUST cite evidence_refs with ref_type (static_analysis, syntax, spec, code_smell, lsp, sandbox). No blocking on speculation.

Easy tasks with passing lint+security: OMIT what_if_analyses.

Schema: what_if_analyses, overall_assessment, approved, revision_feedback, blocking_issues, nonblocking, residual_risks.
blocking_issues: [{description, evidence_refs (REQUIRED), reasoning}]

Set approved=false ONLY with concrete evidence. Medium/low concerns → nonblocking.
"""

CRITIC_SYSTEM_PROMPT_GENTLE = """\
You are a gentle reviewer. Catch confirmed failures only.

ONLY block with concrete evidence_refs (static_analysis, syntax, spec, code_smell, lsp, sandbox). Architectural concerns → nonblocking or residual_risks.

Easy tasks with passing lint+security: OMIT what_if_analyses.

Schema: what_if_analyses, overall_assessment, approved, revision_feedback, blocking_issues, nonblocking, residual_risks.
"""

_model_kwargs: dict[str, Any] = {}
if getattr(settings, "critic_stop_sequence", ""):
    _model_kwargs["stop"] = [settings.critic_stop_sequence]

# Explicitly enable thinking for critic — works with both R1 (medium/large profiles)
# and Qwen3-8B with thinking mode (small profile). R1 always thinks via <think> tags
# regardless; Qwen3 requires enable_thinking=True to activate chain-of-thought.
_model_kwargs.setdefault("extra_body", {})
_model_kwargs["extra_body"]["chat_template_kwargs"] = {"enable_thinking": True}

critic_llm = ChatOpenAI(
    base_url=settings.critic_model_url,
    api_key="not-needed",
    model=settings.critic_model_name,
    temperature=0.1,
    max_completion_tokens=settings.critic_max_tokens,
    use_responses_api=False,
    http_client=get_llm_http_client(uds_path=settings.critic_model_uds or None),
    model_kwargs=_model_kwargs,
)

# Budget Guidance: thinking token budget per task difficulty (arXiv:2506.13752).
# Applies to both R1 and Qwen3-8B thinking mode — max_completion_tokens caps the
# combined <think> + output length proportional to task complexity.
_CRITIC_THINKING_BUDGETS = {
    "easy": 256,
    "medium": 1024,
    "hard": 2048,
}


def _budget_guided_critic(task_size: str) -> ChatOpenAI:
    """Return a critic LLM instance with thinking budget tuned to task difficulty.

    Budget Guidance (arXiv:2506.13752): controls reasoning model thinking
    length via max_completion_tokens scaling. Limits <think>...</think>
    phase proportionally to task complexity for both R1 and Qwen3 models.
    """
    thinking_budget = _CRITIC_THINKING_BUDGETS.get(task_size, 1024)
    total_budget = thinking_budget + 2048  # thinking + output tokens
    return critic_llm.bind(max_completion_tokens=min(total_budget, settings.critic_max_tokens))


async def _fetch_architecture_context(task_desc: str, code: str) -> str:
    """Query synesis_catalog for architecture context (indexer_source=architecture)."""
    try:
        arch_collections = [SYNESIS_CATALOG]
        if not arch_collections:
            return ""

        query = f"{task_desc}\n{code[:500]}"
        results = await retrieve_context(
            query=query,
            collections=arch_collections,
            top_k=3,
            strategy="vector",
            reranker="none",
        )

        if not results:
            return ""

        lines = ["\n\n## Architecture Best Practices"]
        lines.append("The following design patterns and well-architected principles are relevant:")
        for r in results:
            source_label = r.source if r.source != "unknown" else r.collection
            lines.append(f"- [{source_label}]: {r.text[:400]}")
        lines.append("Use these to evaluate the safety implications of the generated code.")

        return "\n".join(lines)

    except Exception as e:
        logger.warning(f"Architecture context retrieval failed (non-blocking): {e}")
        return ""


_IMPORT_PATTERNS = [
    re.compile(r"^\s*import\s+([\w.]+)", re.MULTILINE),
    re.compile(r"^\s*from\s+([\w.]+)\s+import", re.MULTILINE),
    re.compile(r"""require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)""", re.MULTILINE),
    re.compile(r"""import\s+.*\s+from\s+['"]([^'"./][^'"]*)['"]\s*;?""", re.MULTILINE),
    re.compile(r"""^\s*"([^"./][^"]*)"$""", re.MULTILINE),  # Go imports
]

_STDLIB_PREFIXES = {
    "os",
    "sys",
    "json",
    "re",
    "time",
    "datetime",
    "math",
    "io",
    "collections",
    "itertools",
    "functools",
    "pathlib",
    "typing",
    "subprocess",
    "threading",
    "logging",
    "unittest",
    "http",
    "urllib",
    "hashlib",
    "base64",
    "shutil",
    "tempfile",
    "glob",
    "string",
    "textwrap",
    "copy",
    "enum",
    "abc",
    "contextlib",
    "dataclasses",
    "pprint",
    "traceback",
    "inspect",
    "uuid",
    "fmt",
    "net",
    "strings",
    "strconv",
    "sync",
    "context",
    "errors",
    "bytes",
    "bufio",
    "encoding",
    "crypto",
}


def _extract_third_party_imports(code: str) -> list[str]:
    """Extract non-stdlib package names from code using simple regex."""
    packages: set[str] = set()
    for pattern in _IMPORT_PATTERNS:
        for match in pattern.finditer(code):
            pkg = match.group(1).split(".")[0].split("/")[0]
            if pkg and pkg not in _STDLIB_PREFIXES and not pkg.startswith("_"):
                packages.add(pkg)
    return sorted(packages)[:5]


async def _search_library_vulnerabilities(packages: list[str]) -> tuple[list[str], list[str]]:
    """Search for CVE/vulnerability info on third-party packages."""
    all_results: list[str] = []
    queries: list[str] = []
    for pkg in packages:
        query = f"CVE vulnerability {pkg} 2025 2026"
        queries.append(f"[web] {query}")
        results = await search_client.search(query, profile="web", max_results=2)
        all_results.extend(format_search_results(results))
    return all_results, queries


async def _check_license_compatibility(rag_results: list) -> str:
    """Extract repo_license from RAG results and query licenses_v1 for compliance context."""
    try:
        license_set: dict[str, list[str]] = {}
        for r in rag_results:
            lic = getattr(r, "repo_license", "") or ""
            if lic and lic != "unknown":
                src = getattr(r, "source", "unknown")
                repo = src.split(" ")[0].replace("repo:", "") if src.startswith("repo:") else src
                license_set.setdefault(lic, []).append(repo)

        if not license_set:
            return ""

        available = set(discover_collections())
        license_coll = SYNESIS_CATALOG
        if license_coll not in available:
            lines = ["\n\n## License Compliance"]
            lines.append("The generated code draws on patterns from these licensed sources:")
            for lic, repos in license_set.items():
                repo_str = ", ".join(sorted(set(repos))[:3])
                lines.append(f"- {repo_str} ({lic})")
            lines.append("Note: License collection not available for detailed compatibility analysis.")
            return "\n".join(lines)

        spdx_ids = list(license_set.keys())
        query = f"license compatibility {' '.join(spdx_ids)}"
        results = await retrieve_context(
            query=query,
            collections=[license_coll],
            top_k=5,
            strategy="vector",
            reranker="none",
        )

        lines = ["\n\n## License Compliance"]
        lines.append("The generated code draws on patterns from these licensed sources:")
        for lic, repos in license_set.items():
            repo_str = ", ".join(sorted(set(repos))[:3])
            rag_detail = ""
            for r in results:
                if lic.lower() in r.text.lower():
                    status_match = re.search(r"Red Hat.*?Status:\s*(\S+)", r.text)
                    if status_match:
                        rag_detail = f" -- Red Hat: {status_match.group(1)}"
                    break
            lines.append(f"- {repo_str} ({lic}){rag_detail}")

        if len(spdx_ids) > 1:
            compat_lines = []
            for r in results:
                if "compatibility" in r.source.lower() or "->" in r.text:
                    compat_lines.append(f"  - {r.text[:200]}")
            if compat_lines:
                lines.append("\nCompatibility notes:")
                lines.extend(compat_lines[:5])

        lines.append("If the user's project license is known, flag any compatibility concerns.")
        return "\n".join(lines)

    except Exception as e:
        logger.warning(f"License compliance check failed (non-blocking): {e}")
        return ""


async def critic_node(state: dict[str, Any]) -> dict[str, Any]:
    start = time.monotonic()
    node_name = "critic"

    try:
        token_budget = state.get("token_budget_remaining", settings.max_tokens_per_request)
        if settings.max_controller_tokens > 0:
            token_budget = min(token_budget, settings.max_controller_tokens)
        if token_budget <= 0:
            return {
                "critic_approved": True,
                "current_node": node_name,
                "next_node": "respond",
                "reasoning": "Controller token budget exhausted",
                "generated_code": state.get("generated_code", ""),
                "code_explanation": state.get("code_explanation", ""),
                "patch_ops": state.get("patch_ops", []) or [],
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

        generated_code = state.get("generated_code", "")
        task_desc = state.get("task_description", "")
        target_lang = state.get("target_language", "python")
        iteration = state.get("iteration_count", 0)
        max_iterations = state.get("max_iterations", 3)

        if not generated_code:
            return {
                "critic_approved": True,
                "current_node": node_name,
                "next_node": "respond",
                "generated_code": state.get("generated_code", ""),
                "code_explanation": state.get("code_explanation", ""),
                "patch_ops": state.get("patch_ops", []) or [],
                "node_traces": [
                    NodeTrace(
                        node_name=node_name,
                        reasoning="No code to critique",
                        confidence=1.0,
                        outcome=NodeOutcome.SUCCESS,
                        latency_ms=0,
                    )
                ],
            }

        # Taxonomy-driven document depth check: when not is_code_task + high complexity, validate science depth
        is_code_task = state.get("is_code_task", True)
        taxonomy_metadata = state.get("taxonomy_metadata") or {}
        taxonomy_complexity = float(taxonomy_metadata.get("complexity_score", 0))
        is_document_taxonomy_path = (
            not is_code_task and taxonomy_complexity > 0.6 and bool(taxonomy_metadata.get("required_elements"))
        )
        if is_document_taxonomy_path:
            from ..taxonomy_prompt_factory import get_critic_depth_prompt_block

            depth_block = get_critic_depth_prompt_block(taxonomy_metadata)
            doc_system = f"""You are a depth reviewer for document/knowledge responses.

{depth_block}

Evaluate the response below against required_elements for this domain.
- approved=true if it covers required_elements with adequate rigor.
- approved=false if sections are missing/superficial. Use evidence_refs ref_type="spec", id="taxonomy_depth".
- Minor suggestions → nonblocking.

Reply JSON: overall_assessment, approved, revision_feedback, blocking_issues, nonblocking, residual_risks."""
            doc_prompt = (
                f"## Task\n{task_desc}\n\n"
                f"## Taxonomy\nRequired elements: {taxonomy_metadata.get('required_elements', [])}\n\n"
                f"## Executor Response (markdown)\n{generated_code[:8000]}"
            )
            try:
                doc_response = await critic_llm.ainvoke(
                    [
                        SystemMessage(content=doc_system),
                        HumanMessage(content=doc_prompt),
                    ]
                )
                doc_parsed, _ = validate_critic_with_repair(doc_response.content)
            except Exception as doc_err:
                logger.warning("critic_document_depth_failed", extra={"error": str(doc_err)[:200]})
                doc_parsed = None
            if doc_parsed:
                # Document path: skip evidence gate (no sandbox/lsp; taxonomy assessment is the evidence)
                doc_approved = doc_parsed.approved
                _ = getattr(doc_parsed, "blocking_issues", []) or []  # doc_blocking; reserved for future use
                # If critic says not approved but blocking_issues lack refs, still honor the decision (document path)
                doc_next = "respond" if doc_approved else "supervisor"
                latency = (time.monotonic() - start) * 1000
                result = {
                    "what_if_analyses": [],
                    "critic_feedback": doc_parsed.revision_feedback or doc_parsed.overall_assessment or "",
                    "critic_approved": doc_approved,
                    "critic_should_continue": not doc_approved,
                    "critic_continue_reason": "needs_depth_revision" if not doc_approved else None,
                    "residual_risks": getattr(doc_parsed, "residual_risks", []) or [],
                    "current_node": node_name,
                    "next_node": doc_next,
                    "generated_code": state.get("generated_code", ""),
                    "code_explanation": state.get("code_explanation", ""),
                    "patch_ops": state.get("patch_ops", []) or [],
                    "node_traces": [
                        NodeTrace(
                            node_name=node_name,
                            reasoning=doc_parsed.reasoning or f"Taxonomy depth check: approved={doc_approved}",
                            confidence=doc_parsed.confidence,
                            outcome=NodeOutcome.SUCCESS if doc_approved else NodeOutcome.NEEDS_REVISION,
                            latency_ms=latency,
                        )
                    ],
                }
                if not doc_approved:
                    record_critic_rejection()
                    result["supervisor_clarification_only"] = True  # Passthrough to Worker for revision
                return result
            # Fallback on error: approve (degraded) and continue
            return {
                "critic_approved": True,
                "critic_feedback": "Taxonomy depth check failed; proceeding (degraded)",
                "current_node": node_name,
                "next_node": "respond",
                "generated_code": state.get("generated_code", ""),
                "code_explanation": state.get("code_explanation", ""),
                "patch_ops": state.get("patch_ops", []) or [],
                "node_traces": [
                    NodeTrace(
                        node_name=node_name,
                        reasoning="Document depth check errored; approved by default",
                        confidence=0.5,
                        outcome=NodeOutcome.SUCCESS,
                        latency_ms=(time.monotonic() - start) * 1000,
                    )
                ],
            }

        # Advisory Mode: easy/medium tasks skip What-If LLM. Approve if code compiles/runs.
        # Exception: lifestyle vertical with tiered critic may use basic tier (also Advisory-like).
        task_size = state.get("task_size", "medium")

        from ..taxonomy_prompt_factory import (
            get_critic_mode,
            get_critic_tier_prompt,
            get_intent_critic_block,
            resolve_active_vertical,
        )

        active_vertical = resolve_active_vertical(
            active_domain_refs=state.get("active_domain_refs"),
            platform_context=state.get("platform_context"),
        )
        critic_mode = get_critic_mode(active_vertical)

        # Advisory path: non-hard tasks, OR tiered+basic tier
        use_advisory = task_size != "hard"
        tier = ""
        if critic_mode == "tiered":
            tier = "basic" if task_size == "easy" else ("advanced" if task_size == "medium" else "research")
            if tier == "basic":
                use_advisory = True  # basic tier = no What-If, approve if runs

        if use_advisory:
            exit_code = state.get("execution_exit_code")
            lint_passed = state.get("execution_lint_passed", True)
            security_passed = state.get("execution_security_passed", True)
            advisory_approved = (exit_code in (0, None)) and lint_passed and security_passed
            if not advisory_approved:
                record_critic_rejection()
            return {
                "critic_approved": advisory_approved,
                "critic_feedback": "Advisory mode: no What-If analysis"
                if advisory_approved
                else "Advisory: execution or checks failed",
                "critic_should_continue": not advisory_approved,
                "critic_continue_reason": None if advisory_approved else "advisory_reject",
                "what_if_analyses": [],
                "current_node": node_name,
                "next_node": "respond",
                "generated_code": state.get("generated_code", ""),
                "code_explanation": state.get("code_explanation", ""),
                "patch_ops": state.get("patch_ops", []) or [],
                "node_traces": [
                    NodeTrace(
                        node_name=node_name,
                        reasoning=f"Advisory mode (task_size={task_size}, critic={critic_mode}): approved={advisory_approved}",
                        confidence=1.0,
                        outcome=NodeOutcome.SUCCESS,
                        latency_ms=(time.monotonic() - start) * 1000,
                    )
                ],
            }

        arch_block = ""
        if settings.rag_critic_arch_enabled:
            arch_block = await _fetch_architecture_context(task_desc, generated_code)

        license_block = ""
        if settings.rag_critic_license_enabled:
            rag_results = state.get("rag_results", [])
            license_block = await _check_license_compatibility(rag_results)

        # Opt-in: search for known vulnerabilities in imported libraries
        vuln_block = ""
        if settings.web_search_enabled and settings.web_search_critic_enabled:
            packages = _extract_third_party_imports(generated_code)
            if packages:
                vuln_results, _vuln_queries = await _search_library_vulnerabilities(packages)
                if vuln_results:
                    vuln_lines = "\n".join(f"- {r}" for r in vuln_results)
                    vuln_block = (
                        f"\n\n## External Verification\n"
                        f"Web search results for potential vulnerabilities in "
                        f"imported packages ({', '.join(packages)}):\n{vuln_lines}\n"
                        f"Consider these findings in your risk assessment."
                    )
                    logger.info(
                        "critic_vulnerability_search",
                        extra={
                            "packages_searched": packages,
                            "results_count": len(vuln_results),
                        },
                    )

        # task_size already set above
        interaction_mode = state.get("interaction_mode", "do")
        learners_corner = state.get("learners_corner") or {}
        lint_passed = state.get("execution_lint_passed", True)
        security_passed = state.get("execution_security_passed", True)
        omit_whatif = task_size == "easy" and lint_passed and security_passed

        teach_mode_note = ""
        if interaction_mode == "teach":
            has_lc = isinstance(learners_corner, dict) and learners_corner.get("pattern")
            teach_mode_note = (
                f"\ninteraction_mode=teach. Learner's Corner present: {bool(has_lc)}. "
                "If absent, add nonblocking note; do not block."
            )

        tool_refs_block = ""
        tool_refs = state.get("tool_refs") or []
        if tool_refs:
            lines = ["## Available Evidence (cite by id + hash; UI hydrates)"]
            for i, tr in enumerate(tool_refs[:10]):
                t = tr if isinstance(tr, dict) else (tr.model_dump() if hasattr(tr, "model_dump") else {})
                tool_name = t.get("tool", "unknown")
                req_id = t.get("request_id", "")[:8]
                res_hash = t.get("result_hash", "")[:16]
                summary = (t.get("result_summary") or "")[:80]
                art_hashes = t.get("artifact_hashes") or []
                lines.append(f"- {tool_name}_{req_id}: hash={res_hash} summary={summary}")
                for j, ah in enumerate(art_hashes[:3]):
                    lines.append(f"  artifact_{j}: {str(ah)[:16]}")
            tool_refs_block = "\n".join(lines) + "\n\n"

        prompt = (
            f"## Task Description\n{task_desc}\n\n"
            f"## Language\n{target_lang}\n\n"
            f"## Task Size\n{task_size}\n"
            f"Lint passed: {lint_passed}, Security passed: {security_passed}.\n"
            f"{'OMIT what_if_analyses (trivial + lint+security passed).' if omit_whatif else ''}"
            f"{teach_mode_note}\n\n"
            f"{tool_refs_block}"
            f"## Code to Analyze (iteration {iteration})\n"
            f"```{target_lang}\n{generated_code}\n```"
            f"{arch_block}{license_block}{vuln_block}"
        )

        # Adaptive Rigor: Gentle / Full / Tiered (lifestyle, llm_rag, llm_prompting, llm_evaluation)
        critic_prompt = CRITIC_SYSTEM_PROMPT_GENTLE if task_size in ("easy", "medium") else CRITIC_SYSTEM_PROMPT
        if critic_mode == "tiered" and tier:
            effective_tier = "advanced" if task_size == "medium" else "research"
            tier_guide = get_critic_tier_prompt(active_vertical, effective_tier)
            if tier_guide:
                _tier_labels = {
                    "lifestyle": "lifestyle/wellness (running, nutrition, home automation)",
                    "llm_rag": "LLM RAG pipelines (retrieval, chunking, embeddings)",
                    "llm_prompting": "LLM prompting and tool use",
                    "llm_evaluation": "LLM evaluation and benchmarking",
                }
                label = _tier_labels.get(active_vertical, active_vertical)
                critic_prompt = f"""You are a code reviewer for {label}.

TIER: {effective_tier.upper()}
{tier_guide}

Reply JSON: overall_assessment, approved, revision_feedback, blocking_issues, nonblocking, residual_risks.
blocking_issues: Only for confirmed sandbox/lsp failures. Suggestions → nonblocking.
"""
                logger.debug("critic_tiered_mode", extra={"vertical": active_vertical, "tier": effective_tier})

        # Intent-aware overlay: hallucination (Knowledge), schema (Data Transform), tone (Writing), etc.
        intent_class = state.get("intent_class", "code")
        intent_block = get_intent_critic_block(intent_class)
        if intent_block:
            critic_prompt = f"{critic_prompt}\n\n## Intent Class: {intent_class}\n{intent_block}"
            logger.debug("critic_intent_overlay", extra={"intent_class": intent_class})

        messages = [
            SystemMessage(content=critic_prompt),
            HumanMessage(content=prompt),
        ]

        is_truncated = False
        task_size = state.get("task_size", "medium")
        guided_critic = _budget_guided_critic(task_size)
        response = await guided_critic.ainvoke(messages)
        try:
            parsed, is_truncated = validate_critic_with_repair(response.content)
            if is_truncated:
                logger.warning(
                    "critic_response_truncated",
                    extra={"detail": "First N blocking_issues preserved; nonblocking may be omitted"},
                )
        except ValueError as e:
            latency = (time.monotonic() - start) * 1000
            trace = NodeTrace(
                node_name=node_name,
                reasoning=f"Schema validation failed: {e}",
                confidence=0.0,
                outcome=NodeOutcome.ERROR,
                latency_ms=latency,
            )
            logger.warning("critic_schema_validation_failed", extra={"error": str(e)[:200]})
            return {
                "critic_approved": True,
                "critic_feedback": f"Critic output validation failed: {e}",
                "critic_should_continue": False,
                "critic_continue_reason": None,
                "current_node": node_name,
                "next_node": "respond",
                "generated_code": state.get("generated_code", ""),
                "code_explanation": state.get("code_explanation", ""),
                "patch_ops": state.get("patch_ops", []) or [],
                "node_traces": [trace],
            }

        approved = parsed.approved
        blocking_issues = getattr(parsed, "blocking_issues", []) or []

        # Policy engine: evidence gate (§critic_policy_spec)
        approved, has_valid_evidence = check_evidence_gate(approved, blocking_issues)
        if approved and not has_valid_evidence and blocking_issues:
            logger.info(
                "critic_evidence_gate",
                extra={"reason": "approved=false without valid evidence_refs; overriding to approved"},
            )
            revision = getattr(parsed, "revision_feedback", "") or ""
            parsed = parsed.model_copy(
                update={
                    "approved": True,
                    "revision_feedback": (
                        revision + " [Evidence gate: blocking required valid evidence refs; proceeding.]"
                    ).strip()[:500],
                }
            )

        what_ifs_raw = parsed.what_if_analyses or []
        what_ifs = []
        for wif in what_ifs_raw:
            with contextlib.suppress(Exception):
                what_ifs.append(
                    WhatIfAnalysis(
                        scenario=wif.get("scenario", ""),
                        risk_level=wif.get("risk_level", "medium"),
                        explanation=wif.get("explanation", ""),
                        suggested_mitigation=wif.get("suggested_mitigation"),
                    )
                )

        at_max_iterations = should_force_pass(iteration + 1, max_iterations)
        carried_uncertainties_signal = None
        if at_max_iterations:
            if not approved:
                logger.warning(
                    "critic_max_iterations_forced_approval",
                    extra={"iteration": iteration, "max_iterations": max_iterations},
                )
                approved = True
            failure_type = state.get("failure_type", "runtime")
            stages_passed = state.get("stages_passed", [])
            integrity_reason = state.get("integrity_failure_reason", "")
            integrity_fail = state.get("integrity_failure") or {}
            # §7.7: actionable ops signal (legacy)
            if integrity_reason and isinstance(integrity_fail, dict) and integrity_fail.get("remediation"):
                suggested_system_fix = integrity_fail.get("remediation", "")
            elif failure_type == "lsp":
                suggested_system_fix = "Add package to integrity_trusted_packages or enable LSP mode."
            elif failure_type in ("lint", "security"):
                suggested_system_fix = "Review lint/security rules or relax revision constraints."
            else:
                suggested_system_fix = "Update touched_files manifest or revision constraints."
            # Universal carried uncertainties (known unknowns surfaced)
            intent_class = state.get("intent_class", "code")
            carried_uncertainties_signal = build_universal_carried_uncertainties_signal(
                state,
                intent_class,
                active_vertical,
                task_size,
                at_max_iterations=True,
                failure_type=failure_type,
                task_desc=task_desc,
                stages_passed=stages_passed,
                suggested_system_fix=suggested_system_fix,
            )
            carried_uncertainties_signal["dominant_stage"] = "gate" if integrity_reason else (failure_type or "runtime")
            carried_uncertainties_signal["dominant_rule"] = (
                f"{integrity_reason}: {(integrity_fail.get('evidence') or '')[:80]}"
                if integrity_reason
                else f"{failure_type}: {failure_type}"
            )[:200]
        else:
            # Emit light carried uncertainties when relevant (knowledge gap, lifestyle quick answer, residual risks)
            intent_class = state.get("intent_class", "code")
            light_signal = build_universal_carried_uncertainties_signal(state, intent_class, active_vertical, task_size)
            if light_signal.get("items"):
                carried_uncertainties_signal = light_signal

        if approved:
            next_node = "respond"
        else:
            next_node = "supervisor"

        # Stop condition for routing
        critic_should_continue = not approved
        critic_continue_reason = parsed.continue_reason or (
            "needs_evidence" if parsed.need_more_evidence else ("needs_revision" if not approved else None)
        )

        latency = (time.monotonic() - start) * 1000
        trace = NodeTrace(
            node_name=node_name,
            reasoning=parsed.reasoning or "",
            assumptions=[],
            confidence=parsed.confidence,
            outcome=NodeOutcome.SUCCESS if approved else NodeOutcome.NEEDS_REVISION,
            latency_ms=latency,
            tokens_used=response.usage_metadata.get("total_tokens", 0) if (response and response.usage_metadata) else 0,
        )

        logger.info(
            "critic_decision",
            extra={
                "approved": approved,
                "risk_count": len(what_ifs),
                "high_risks": sum(1 for w in what_ifs if w.risk_level in ("high", "critical")),
                "iteration": iteration,
                "forced_approval": at_max_iterations and not parsed.approved,
                "latency_ms": latency,
            },
        )

        # §7.3: needs_evidence increments evidence_experiments_count, not iteration_count
        is_evidence_only = critic_continue_reason == "needs_evidence"
        evidence_count = state.get("evidence_experiments_count", 0)
        if not approved:
            record_critic_rejection()

        # Cache critic-approved results for instant recall on repeat tasks
        if approved:
            _code = state.get("generated_code", "")
            _task_desc = state.get("task_description", "")
            _lang = state.get("target_language", "python")
            if _code and _task_desc:
                try:
                    from ..failfast_cache import cache as failfast_cache

                    failfast_cache.put(
                        _task_desc,
                        _lang,
                        "success",
                        _code,
                        explanation=state.get("code_explanation", ""),
                    )
                except Exception as _cache_err:
                    logger.debug("critic_cache_store_failed: %s", _cache_err)

        result: dict[str, Any] = {
            "what_if_analyses": what_ifs,
            "critic_feedback": parsed.revision_feedback or parsed.overall_assessment or "",
            "critic_approved": approved,
            "critic_response_truncated": is_truncated,
            "critic_should_continue": critic_should_continue,
            "critic_continue_reason": critic_continue_reason,
            "critic_needs_testing": getattr(parsed, "needs_testing", False),
            "need_more_evidence": parsed.need_more_evidence or False,
            "residual_risks": getattr(parsed, "residual_risks", []) or [],
            "critic_nonblocking": getattr(parsed, "nonblocking", []) or [],
            "current_node": node_name,
            "next_node": next_node,
            "iteration_count": iteration + 1 if not is_evidence_only else iteration,
            "evidence_experiments_count": evidence_count + 1 if is_evidence_only else evidence_count,
            "node_traces": [trace],
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
        }
        if carried_uncertainties_signal:
            result["carried_uncertainties_signal"] = carried_uncertainties_signal
        # §7.8: When Critic routes to Supervisor, Supervisor may only ask clarification—not re-plan.
        if critic_should_continue or parsed.need_more_evidence:
            result["supervisor_clarification_only"] = True
        # Policy engine: monotonic retry state (§critic_policy_spec)
        if critic_should_continue and not is_evidence_only:
            fids = state.get("failure_ids_seen") or []
            retry_delta = retry_state_updates(
                state,
                "RETRY",
                critic_continue_reason or "needs_revision",
                failure_type=state.get("failure_type"),
                failure_id=fids[-1] if fids else None,
            )
            if retry_delta.get("retry"):
                result["retry"] = {**state.get("retry", {}), **retry_delta["retry"]}
        elif approved:
            retry_delta = retry_state_updates(state, "PASS", "approved")
            if retry_delta.get("retry"):
                result["retry"] = {**state.get("retry", {}), **retry_delta["retry"]}
        # needs_more_evidence: emit retrieval query plan (no tool calls)
        if parsed.need_more_evidence:
            result["evidence_needed"] = build_evidence_needed_query_plan(
                getattr(parsed, "evidence_gap", None),
                state.get("intent_class", "code"),
            )
        return result

    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.exception("critic_error")
        trace = NodeTrace(
            node_name=node_name,
            reasoning=f"Error: {e}",
            assumptions=[],
            confidence=0.0,
            outcome=NodeOutcome.ERROR,
            latency_ms=latency,
        )
        return {
            "critic_approved": True,
            "critic_feedback": f"Critic error (degraded mode): {e}",
            "critic_should_continue": False,
            "critic_continue_reason": None,
            "current_node": node_name,
            "next_node": "respond",
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "node_traces": [trace],
        }
