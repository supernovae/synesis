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
    failures: list[str] = field(default_factory=list)
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
                    "failures": c.failures,
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

    failures = _check_expectations(case, latency, tokens, data)

    return CaseResult(
        case_index=index,
        prompt_snippet=snippet,
        category=case.category,
        passed=len(failures) == 0,
        latency_ms=latency,
        tokens=tokens,
        actual_decision_path=data.get("_decision_path"),
        actual_recall_routing=data.get("_recall_routing"),
        failures=failures,
    )


def _check_expectations(
    case: EvalCase,
    latency_ms: float,
    tokens: int,
    response_data: dict,
) -> list[str]:
    """Compare actual results against case expectations. Returns list of failure reasons."""
    failures: list[str] = []

    if case.max_latency_ms is not None and latency_ms > case.max_latency_ms:
        failures.append(f"latency {latency_ms:.0f}ms exceeds max {case.max_latency_ms}ms")

    if case.max_tokens is not None and tokens > case.max_tokens:
        failures.append(f"tokens {tokens} exceeds max {case.max_tokens}")

    usage = response_data.get("usage", {})
    if usage.get("total_tokens", 0) == 0 and tokens == 0:
        pass  # can't check token budget without data

    choices = response_data.get("choices", [])
    if not choices:
        failures.append("no response choices returned")

    return failures
