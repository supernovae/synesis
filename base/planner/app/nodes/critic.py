"""Critic node -- Safety-II "What-If" analysis using Mistral Nemo supervisor model.

Instead of binary pass/fail, the critic generates scenario-based risk
analysis. This follows the Joint Cognitive System principle: the critic
is a teammate that enriches understanding, not a gate that blocks.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..config import settings
from ..rag_client import discover_collections, retrieve_context
from ..state import NodeOutcome, NodeTrace, WhatIfAnalysis
from ..web_search import format_search_results, search_client

logger = logging.getLogger("synesis.critic")

CRITIC_SYSTEM_PROMPT = """\
You are the Safety Critic in a Safety-II Joint Cognitive System called Synesis.
Your job is NOT to pass or fail code. Your job is to enrich understanding through
"What-If" scenario analysis.

For the given code, generate scenarios that a senior SRE or security engineer
would worry about. Think about:
- What if the input is empty, malformed, or adversarial?
- What if this runs as root vs. unprivileged user?
- What if the filesystem is full, network is down, or a dependency is missing?
- What if this is executed in a pipeline (no TTY, no stdin)?
- What if the locale, timezone, or shell version differs?
- What if there's a race condition or concurrency issue?

You MUST respond with valid JSON:
{
  "what_if_analyses": [
    {
      "scenario": "What if the input file does not exist?",
      "risk_level": "high",
      "explanation": "The script will fail with an unclear error...",
      "suggested_mitigation": "Add an explicit file existence check with a descriptive error message"
    }
  ],
  "overall_assessment": "Summary of code quality and safety posture",
  "approved": true/false,
  "revision_feedback": "If not approved, specific instructions for the worker to fix",
  "confidence": 0.0 to 1.0,
  "reasoning": "Your reasoning process"
}

Set approved=false ONLY if there are HIGH or CRITICAL risk scenarios that
have no mitigations in the current code. Medium and low risks should be
noted but don't block approval.
"""

critic_llm = ChatOpenAI(
    base_url=settings.supervisor_model_url,
    api_key="not-needed",
    model=settings.supervisor_model_name,
    temperature=0.3,
    max_tokens=2048,
)


async def _fetch_architecture_context(task_desc: str, code: str) -> str:
    """Query architecture collections and format results for the Critic prompt."""
    try:
        available = set(discover_collections())
        arch_collections = [c for c in available if c.startswith("arch_")]

        explicit = settings.rag_arch_collections
        if explicit:
            arch_collections = [c for c in explicit if c in available]

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
        if "licenses_v1" not in available:
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
            collections=["licenses_v1"],
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
        generated_code = state.get("generated_code", "")
        task_desc = state.get("task_description", "")
        target_lang = state.get("target_language", "bash")
        iteration = state.get("iteration_count", 0)
        max_iterations = state.get("max_iterations", 3)

        if not generated_code:
            return {
                "critic_approved": True,
                "current_node": node_name,
                "next_node": "respond",
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

        prompt = (
            f"## Task Description\n{task_desc}\n\n"
            f"## Language\n{target_lang}\n\n"
            f"## Code to Analyze (iteration {iteration})\n"
            f"```{target_lang}\n{generated_code}\n```"
            f"{arch_block}{license_block}{vuln_block}"
        )

        messages = [
            SystemMessage(content=CRITIC_SYSTEM_PROMPT),
            HumanMessage(content=prompt),
        ]

        response = await critic_llm.ainvoke(messages)

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
                    "approved": True,
                    "what_if_analyses": [],
                    "overall_assessment": "Could not parse critic response",
                    "confidence": 0.3,
                    "reasoning": "JSON parse failure -- defaulting to approved",
                }

        approved = parsed.get("approved", True)
        what_ifs = [WhatIfAnalysis(**wif) for wif in parsed.get("what_if_analyses", [])]

        at_max_iterations = iteration + 1 >= max_iterations
        if at_max_iterations and not approved:
            logger.warning(
                "critic_max_iterations_forced_approval",
                extra={"iteration": iteration, "max_iterations": max_iterations},
            )
            approved = True

        if approved:
            next_node = "respond"
        else:
            next_node = "supervisor"

        latency = (time.monotonic() - start) * 1000
        trace = NodeTrace(
            node_name=node_name,
            reasoning=parsed.get("reasoning", ""),
            assumptions=[],
            confidence=parsed.get("confidence", 0.5),
            outcome=NodeOutcome.SUCCESS if approved else NodeOutcome.NEEDS_REVISION,
            latency_ms=latency,
            tokens_used=response.usage_metadata.get("total_tokens", 0) if response.usage_metadata else 0,
        )

        logger.info(
            "critic_decision",
            extra={
                "approved": approved,
                "risk_count": len(what_ifs),
                "high_risks": sum(1 for w in what_ifs if w.risk_level in ("high", "critical")),
                "iteration": iteration,
                "forced_approval": at_max_iterations and not parsed.get("approved", True),
                "latency_ms": latency,
            },
        )

        return {
            "what_if_analyses": what_ifs,
            "critic_feedback": parsed.get("revision_feedback", parsed.get("overall_assessment", "")),
            "critic_approved": approved,
            "current_node": node_name,
            "next_node": next_node,
            "iteration_count": iteration + 1,
            "node_traces": [trace],
        }

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
            "current_node": node_name,
            "next_node": "respond",
            "node_traces": [trace],
        }
