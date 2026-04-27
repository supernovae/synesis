"""Golden-prompt eval harness for Yarn decision quality regression detection.

Runs curated prompt suites against Yarn's OpenAI-compatible API, fetches
resulting traces, and compares actual decision paths, recall routing, and
verification outcomes against expected values.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..deps import INTERNAL_SERVICE_TOKEN

logger = logging.getLogger("synesis.admin.eval_harness")


@dataclass
class EvalCase:
    prompt: str
    category: str = "general"
    expected_decision_path: str | None = None
    expected_recall_routing: str | None = None
    expected_languages: list[str] | None = None
    max_latency_ms: float | None = None
    max_tokens: int | None = None


@dataclass
class EvalSuite:
    name: str
    cases: list[EvalCase]
    model: str = "synesis-agent"
    description: str = ""


@dataclass
class CaseResult:
    case_index: int
    prompt_snippet: str
    category: str
    passed: bool
    latency_ms: float = 0
    tokens: int = 0
    actual_decision_path: str | None = None
    actual_recall_routing: str | None = None
    actual_languages: list[str] | None = None
    decision_path_match: bool | None = None
    recall_routing_match: bool | None = None
    language_match: bool | None = None
    failures: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    error: str | None = None


@dataclass
class EvalResult:
    suite_name: str
    total_cases: int
    passed: int
    failed: int
    errored: int
    pass_rate: float
    cases: list[CaseResult]
    elapsed_ms: float = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "suite_name": self.suite_name,
            "total_cases": self.total_cases,
            "passed": self.passed,
            "failed": self.failed,
            "errored": self.errored,
            "pass_rate": round(self.pass_rate, 4),
            "elapsed_ms": round(self.elapsed_ms, 1),
            "cases": [
                {
                    "case_index": c.case_index,
                    "prompt_snippet": c.prompt_snippet,
                    "category": c.category,
                    "passed": c.passed,
                    "latency_ms": round(c.latency_ms, 1),
                    "tokens": c.tokens,
                    "actual_decision_path": c.actual_decision_path,
                    "actual_recall_routing": c.actual_recall_routing,
                    "actual_languages": c.actual_languages,
                    "decision_path_match": c.decision_path_match,
                    "recall_routing_match": c.recall_routing_match,
                    "language_match": c.language_match,
                    "failures": c.failures,
                    "warnings": c.warnings,
                    "error": c.error,
                }
                for c in self.cases
            ],
        }


# ---------------------------------------------------------------------------
# Built-in eval suites
# ---------------------------------------------------------------------------

BUILTIN_SUITES: dict[str, EvalSuite] = {
    "recall_bypass": EvalSuite(
        name="recall_bypass",
        description="Prompts expected to hit deterministic fast paths via recall engine",
        cases=[
            EvalCase(
                prompt="What is the TypeScript strict mode compiler flag?",
                category="recall_bypass",
                expected_decision_path="deterministic",
                expected_recall_routing="bypass",
                expected_languages=["typescript"],
            ),
            EvalCase(
                prompt="What does the Go 'defer' keyword do?",
                category="recall_bypass",
                expected_decision_path="deterministic",
                expected_languages=["go"],
            ),
            EvalCase(
                prompt="What is the Python list comprehension syntax?",
                category="recall_bypass",
                expected_languages=["python"],
            ),
            EvalCase(
                prompt="What does 'use strict' do in JavaScript?",
                category="recall_bypass",
                expected_languages=["javascript"],
            ),
            EvalCase(
                prompt="How do you declare a variable in Rust?",
                category="recall_bypass",
                expected_languages=["rust"],
            ),
        ],
    ),
    "verification_loop": EvalSuite(
        name="verification_loop",
        description="Prompts that should trigger verification loops with tool output",
        cases=[
            EvalCase(
                prompt="Fix this TypeScript error: Type 'string' is not assignable to type 'number'",
                category="verification_loop",
                expected_languages=["typescript"],
            ),
            EvalCase(
                prompt="Fix this Go compilation error: undefined: fmt.Printlnn",
                category="verification_loop",
                expected_languages=["go"],
            ),
            EvalCase(
                prompt="Fix this Python linting error: E302 expected 2 blank lines, got 1",
                category="verification_loop",
                expected_languages=["python"],
            ),
        ],
    ),
    "decision_quality": EvalSuite(
        name="decision_quality",
        description="Mixed prompts testing decision path routing quality",
        cases=[
            EvalCase(
                prompt="Write a REST API endpoint in Go that handles pagination",
                category="inference_task",
                expected_languages=["go"],
            ),
            EvalCase(
                prompt="Explain the difference between mutex and channel in Go",
                category="knowledge_recall",
                expected_languages=["go"],
            ),
            EvalCase(
                prompt="Refactor this 500-line Python module into smaller, testable units using dependency injection and proper separation of concerns",
                category="complex_task",
            ),
            EvalCase(
                prompt="What HTTP status code should I return for a rate-limited request?",
                category="knowledge_recall",
                expected_decision_path="deterministic",
            ),
        ],
    ),
    "stability_invalid_tool_args": EvalSuite(
        name="stability_invalid_tool_args",
        description="Prompts designed to stress invalid tool argument recovery behavior",
        cases=[
            EvalCase(
                prompt=(
                    "Resume implementing the doctor diagnostics feature after a failed tool call. "
                    "Prefer one concrete fix action and avoid repeating broad checks."
                ),
                category="invalid_tool_recovery",
                expected_languages=["go"],
                max_tokens=5000,
            ),
            EvalCase(
                prompt=(
                    "The prior edit failed due to argument mismatch. Read only what is needed and apply one corrected edit."
                ),
                category="invalid_tool_recovery",
                max_tokens=5000,
            ),
            EvalCase(
                prompt=("Continue the task after an 'Invalid tool parameters' error without restarting from scratch."),
                category="invalid_tool_recovery",
                max_tokens=5000,
            ),
        ],
    ),
    "stability_compile_fix_recovery": EvalSuite(
        name="stability_compile_fix_recovery",
        description="Compile-fix loops should converge to narrow recovery and continue implementation",
        cases=[
            EvalCase(
                prompt=(
                    "go build failed with: undefined: api.Options and assignment mismatch in doctor.go. "
                    "Fix the interface usage and continue with the requested feature."
                ),
                category="compile_fix_recovery",
                expected_languages=["go"],
                max_tokens=7000,
            ),
            EvalCase(
                prompt=(
                    "A TypeScript build failed after a refactor. Recover by making one focused fix and rerun a narrow verification."
                ),
                category="compile_fix_recovery",
                expected_languages=["typescript"],
                max_tokens=7000,
            ),
            EvalCase(
                prompt=(
                    "Python lint and test failures appeared after edits. Resolve root cause without rerunning full-suite loops."
                ),
                category="compile_fix_recovery",
                expected_languages=["python"],
                max_tokens=7000,
            ),
        ],
    ),
    "stability_resume_continuity": EvalSuite(
        name="stability_resume_continuity",
        description="Resume prompts should continue task state instead of restarting exploratory loops",
        cases=[
            EvalCase(
                prompt="Please resume the remaining work items and continue from current state.",
                category="resume_continuity",
                max_tokens=5000,
            ),
            EvalCase(
                prompt="Continue from where you left off and complete the next unresolved implementation task.",
                category="resume_continuity",
                max_tokens=5000,
            ),
            EvalCase(
                prompt="Resume and finish doctor command enhancements, then run targeted verification.",
                category="resume_continuity",
                expected_languages=["go"],
                max_tokens=5000,
            ),
        ],
    ),
    "stability_plan_update_loop": EvalSuite(
        name="stability_plan_update_loop",
        description="Plan maintenance prompts should avoid reread loops and proceed with edit/update actions",
        cases=[
            EvalCase(
                prompt=(
                    "Update the plan with completed Phase 4 items, then continue the next incomplete implementation step."
                ),
                category="plan_update_loop",
                max_tokens=5000,
            ),
            EvalCase(
                prompt=(
                    "Mark done items in the plan file and continue coding the next task without rereading the plan repeatedly."
                ),
                category="plan_update_loop",
                max_tokens=5000,
            ),
            EvalCase(
                prompt="Show current plan status and then perform exactly one concrete follow-up action.",
                category="plan_update_loop",
                max_tokens=5000,
            ),
        ],
    ),
    "pattern_recall": EvalSuite(
        name="pattern_recall",
        description="Prompts expected to trigger compositional pattern recall from the pattern library",
        cases=[
            EvalCase(
                prompt="Write a Go HTTP handler with middleware for request logging",
                category="pattern_recall",
                expected_languages=["go"],
            ),
            EvalCase(
                prompt="Create a Python FastAPI endpoint with Pydantic validation for a user registration",
                category="pattern_recall",
                expected_languages=["python"],
            ),
            EvalCase(
                prompt="Build a TypeScript Express route with Zod input validation",
                category="pattern_recall",
                expected_languages=["typescript"],
            ),
            EvalCase(
                prompt="Scaffold a Rust axum handler with JWT extraction",
                category="pattern_recall",
                expected_languages=["rust"],
            ),
            EvalCase(
                prompt="Fix this TypeScript type error: TS2345 type mismatch",
                category="error_not_pattern",
                expected_languages=["typescript"],
            ),
            EvalCase(
                prompt="Explain Kubernetes pod networking and service discovery",
                category="knowledge_not_pattern",
            ),
        ],
    ),
    "latency_budget": EvalSuite(
        name="latency_budget",
        description="Latency and token budget assertions",
        cases=[
            EvalCase(
                prompt="What is a goroutine?",
                category="latency",
                max_latency_ms=10000,
                max_tokens=2000,
                expected_languages=["go"],
            ),
            EvalCase(
                prompt="What does npm init do?",
                category="latency",
                max_latency_ms=10000,
                max_tokens=2000,
                expected_languages=["javascript"],
            ),
        ],
    ),
}


def list_suites() -> list[dict[str, Any]]:
    return [
        {
            "name": s.name,
            "description": s.description,
            "case_count": len(s.cases),
            "categories": list({c.category for c in s.cases}),
        }
        for s in BUILTIN_SUITES.values()
    ]


# ---------------------------------------------------------------------------
# Eval execution
# ---------------------------------------------------------------------------


async def run_eval_suite(
    suite: EvalSuite,
    yarn_url: str,
) -> EvalResult:
    """Execute an eval suite against Yarn and compare results with expectations."""
    t0 = time.time()
    results: list[CaseResult] = []

    for i, case in enumerate(suite.cases):
        case_result = await _run_single_case(i, case, suite.model, yarn_url)
        results.append(case_result)

    passed = sum(1 for r in results if r.passed)
    errored = sum(1 for r in results if r.error is not None)
    failed = len(results) - passed - errored

    return EvalResult(
        suite_name=suite.name,
        total_cases=len(results),
        passed=passed,
        failed=failed,
        errored=errored,
        pass_rate=passed / max(len(results), 1),
        cases=results,
        elapsed_ms=(time.time() - t0) * 1000,
    )


async def _run_single_case(
    index: int,
    case: EvalCase,
    model: str,
    yarn_url: str,
) -> CaseResult:
    """Run a single eval case: call Yarn, fetch trace, compare expectations."""
    snippet = case.prompt[:80]
    t0 = time.time()

    try:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if INTERNAL_SERVICE_TOKEN:
            headers["Authorization"] = f"Bearer {INTERNAL_SERVICE_TOKEN}"

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{yarn_url.rstrip('/')}/v1/chat/completions",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": case.prompt}],
                    "max_tokens": 512,
                    "stream": False,
                },
                headers=headers,
            )
            latency = (time.time() - t0) * 1000

            if resp.status_code >= 400:
                return CaseResult(
                    case_index=index,
                    prompt_snippet=snippet,
                    category=case.category,
                    passed=False,
                    latency_ms=latency,
                    error=f"Yarn returned HTTP {resp.status_code}",
                )

            data = resp.json()
            tokens = data.get("usage", {}).get("total_tokens", 0)

    except Exception as exc:
        return CaseResult(
            case_index=index,
            prompt_snippet=snippet,
            category=case.category,
            passed=False,
            latency_ms=(time.time() - t0) * 1000,
            error=str(exc)[:200],
        )

    expectations = _check_expectations(case, latency, tokens, data)

    return CaseResult(
        case_index=index,
        prompt_snippet=snippet,
        category=case.category,
        passed=len(expectations.failures) == 0,
        latency_ms=latency,
        tokens=tokens,
        actual_decision_path=data.get("_decision_path"),
        actual_recall_routing=data.get("_recall_routing"),
        actual_languages=expectations.actual_languages,
        decision_path_match=expectations.decision_path_match,
        recall_routing_match=expectations.recall_routing_match,
        language_match=expectations.language_match,
        failures=expectations.failures,
        warnings=expectations.warnings,
    )


@dataclass
class _ExpectationResult:
    failures: list[str]
    warnings: list[str]
    decision_path_match: bool | None
    recall_routing_match: bool | None
    language_match: bool | None
    actual_languages: list[str] | None


def _check_expectations(
    case: EvalCase,
    latency_ms: float,
    tokens: int,
    response_data: dict,
) -> _ExpectationResult:
    """Compare actual results against case expectations.

    Hard assertions (failures): latency, tokens, response presence.
    Soft assertions (warnings): decision path, recall routing, languages.
    """
    failures: list[str] = []
    warnings: list[str] = []
    dp_match: bool | None = None
    rr_match: bool | None = None
    lang_match: bool | None = None
    actual_langs: list[str] | None = None

    if case.max_latency_ms is not None and latency_ms > case.max_latency_ms:
        failures.append(f"latency {latency_ms:.0f}ms exceeds max {case.max_latency_ms}ms")

    if case.max_tokens is not None and tokens > case.max_tokens:
        failures.append(f"tokens {tokens} exceeds max {case.max_tokens}")

    choices = response_data.get("choices", [])
    if not choices:
        failures.append("no response choices returned")

    actual_dp = response_data.get("_decision_path")
    if case.expected_decision_path is not None and actual_dp is not None:
        dp_match = actual_dp == case.expected_decision_path
        if not dp_match:
            warnings.append(f"decision_path mismatch: expected={case.expected_decision_path}, actual={actual_dp}")

    actual_rr = response_data.get("_recall_routing")
    if case.expected_recall_routing is not None and actual_rr is not None:
        rr_match = actual_rr == case.expected_recall_routing
        if not rr_match:
            warnings.append(f"recall_routing mismatch: expected={case.expected_recall_routing}, actual={actual_rr}")

    detected = response_data.get("_detected_languages")
    if isinstance(detected, list):
        actual_langs = detected
    if case.expected_languages is not None and actual_langs is not None:
        expected_set = set(l.lower() for l in case.expected_languages)
        actual_set = set(l.lower() for l in actual_langs)
        lang_match = bool(expected_set & actual_set)
        if not lang_match:
            warnings.append(f"language mismatch: expected={case.expected_languages}, actual={actual_langs}")

    return _ExpectationResult(
        failures=failures,
        warnings=warnings,
        decision_path_match=dp_match,
        recall_routing_match=rr_match,
        language_match=lang_match,
        actual_languages=actual_langs,
    )
