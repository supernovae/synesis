#!/usr/bin/env python3
"""Synesis Prompt Test Harness — automated regression testing against the planner API.

Reads test_prompts_100.yaml, sends each prompt to the planner's OpenAI-compatible
endpoint, parses SSE streams, captures timing/behavior metrics, and produces a
structured YAML report with pass/warn/fail verdicts.

Usage:
    # Against external route (default):
    python tests/prompts/run_test_suite.py --api-url https://synesis-api.apps.openshiftdemo.dev

    # Against internal service:
    python tests/prompts/run_test_suite.py --api-url http://synesis-planner.synesis-planner.svc.cluster.local:8000

    # Run a single category:
    python tests/prompts/run_test_suite.py --category knowledge

    # Run specific prompt IDs:
    python tests/prompts/run_test_suite.py --ids know-01 conv-01a conv-01b

    # Dry run (validate YAML, show plan):
    python tests/prompts/run_test_suite.py --dry-run

Requires: httpx, pyyaml (both in planner requirements already)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

try:
    import httpx
except ImportError:
    sys.exit("httpx required: pip install httpx")

try:
    import yaml
except ImportError:
    sys.exit("pyyaml required: pip install pyyaml")


SUITE_PATH = Path(__file__).parent / "test_prompts.yaml"
DEFAULT_API_URL = os.environ.get("SYNESIS_API_URL", "https://synesis-api.apps.openshiftdemo.dev")
DEFAULT_API_KEY = os.environ.get("SYNESIS_API_KEY", "sk-synesis-test")
DEFAULT_MODEL = os.environ.get("SYNESIS_MODEL", "synesis-agent")
TIMEOUT_S = 120

# ── Category-level defaults for reasoning/phase evaluation ──────────────────
# Each category gets sensible defaults; individual prompts can override.
CATEGORY_DEFAULTS: dict[str, dict] = {
    "trivial": {
        "max_reasoning_s": 1.5,
        "max_reasoning_ratio": 1.0,
        "token_budget_tier": "easy",
    },
    "performance": {
        "max_reasoning_s": 1.5,
        "max_reasoning_ratio": 0.5,
        "token_budget_tier": "easy",
    },
    "knowledge": {
        "max_reasoning_s": 8,
        "max_reasoning_ratio": 3.0,
        "token_budget_tier": "medium",
    },
    "taxonomy": {
        "max_reasoning_s": 8,
        "max_reasoning_ratio": 3.0,
        "token_budget_tier": "medium",
    },
    "conversation": {
        "max_reasoning_s": 8,
        "max_reasoning_ratio": 3.0,
        "token_budget_tier": "medium",
    },
    "creative": {
        "max_reasoning_s": 5,
        "max_reasoning_ratio": 2.0,
        "token_budget_tier": "medium",
    },
    "formatting": {
        "max_reasoning_s": 5,
        "max_reasoning_ratio": 2.0,
        "token_budget_tier": "medium",
    },
    "planning": {
        "max_reasoning_s": 10,
        "max_reasoning_ratio": 3.0,
        "token_budget_tier": "medium",
    },
    "comparison": {
        "max_reasoning_s": 10,
        "max_reasoning_ratio": 3.0,
        "token_budget_tier": "medium",
    },
    "persona": {
        "max_reasoning_s": 8,
        "max_reasoning_ratio": 3.0,
        "token_budget_tier": "medium",
    },
    "code": {
        "max_reasoning_s": 12,
        "max_reasoning_ratio": 4.0,
        "token_budget_tier": "medium",
    },
    "review": {
        "max_reasoning_s": 10,
        "max_reasoning_ratio": 3.0,
        "token_budget_tier": "medium",
    },
    "mixed": {
        "max_reasoning_s": 12,
        "max_reasoning_ratio": 4.0,
        "token_budget_tier": "medium",
    },
    "multi_step": {
        "max_reasoning_s": 20,
        "max_reasoning_ratio": 6.0,
        "token_budget_tier": "hard",
    },
    "edge_case": {
        "max_reasoning_s": 3,
        "max_reasoning_ratio": 2.0,
        "token_budget_tier": "medium",
    },
    "safety": {
        "max_reasoning_s": 5,
        "max_reasoning_ratio": 2.0,
        "token_budget_tier": "medium",
    },
    "rapid": {
        "max_reasoning_s": 3,
        "max_reasoning_ratio": 1.5,
        "token_budget_tier": "medium",
    },
    "pivot": {
        "max_reasoning_s": 8,
        "max_reasoning_ratio": 3.0,
        "token_budget_tier": "medium",
    },
    "node_routing": {
        "max_reasoning_s": 8,
        "max_reasoning_ratio": 3.0,
        "token_budget_tier": "medium",
    },
    "regression": {
        "max_reasoning_s": 8,
        "max_reasoning_ratio": 3.0,
        "token_budget_tier": "medium",
    },
}

# Fallback for unknown categories
_DEFAULT_CATEGORY = {"max_reasoning_s": 10, "max_reasoning_ratio": 3.0, "token_budget_tier": "medium"}


def _derive_expected_phases(
    expected_route: str,
    expected_deliverable: str,
    category: str,
) -> list[str]:
    """Derive expected pipeline status phases from the prompt's routing metadata."""
    if category in ("trivial", "performance"):
        return ["Analyzing"]

    if category == "edge_case":
        return ["Analyzing"]

    if expected_deliverable == "explain_only":
        return ["Analyzing", "Detecting domain", "Gathering context", "Creating your plan"]

    if expected_route == "planner" or expected_deliverable == "code_project":
        return [
            "Complex task detected",
            "Building execution plan",
            "Architecting solution",
            "Validating",
            "Reviewing",
        ]

    if expected_deliverable in ("code_snippet",):
        return ["Analyzing", "Detecting domain", "Gathering context", "Generating code"]

    return ["Analyzing"]


def _get_threshold(prompt_spec: dict, key: str) -> float:
    """Get a threshold from the prompt spec, falling back to category defaults."""
    if key in prompt_spec:
        return float(prompt_spec[key])
    cat = prompt_spec.get("category", "")
    defaults = CATEGORY_DEFAULTS.get(cat, _DEFAULT_CATEGORY)
    return float(defaults.get(key, _DEFAULT_CATEGORY[key]))


def load_suite(path: Path) -> list[dict]:
    with open(path) as f:
        return yaml.safe_load(f)


def group_sequences(prompts: list[dict]) -> list[list[dict]]:
    """Group prompts into execution batches. Null sequence = standalone. Same group_id = ordered sequence."""
    standalone = []
    sequences: dict[str, list[dict]] = defaultdict(list)

    for p in prompts:
        seq = p.get("sequence")
        if not seq:
            standalone.append([p])
        else:
            group_id = seq.split(":")[0]
            sequences[group_id].append(p)

    for group in sequences.values():
        group.sort(key=lambda x: x.get("sequence", ""))

    return standalone + list(sequences.values())


class PhaseEvent:
    """A single pipeline status event with arrival timing."""

    __slots__ = ("description", "done", "offset_ms")

    def __init__(self, description: str, done: bool, offset_ms: int):
        self.description = description
        self.done = done
        self.offset_ms = offset_ms

    def to_dict(self) -> dict:
        d: dict = {"description": self.description, "offset_ms": self.offset_ms}
        if self.done:
            d["done"] = True
        return d


class SSEMetrics:
    """Captures timing, content, phase, and reasoning metrics from an SSE stream."""

    def __init__(self):
        self.time_request_sent: float = 0
        self.time_first_event: float = 0
        self.time_first_reasoning: float = 0
        self.time_last_reasoning: float = 0
        self.time_first_content: float = 0
        self.time_complete: float = 0
        self.reasoning_chunks: int = 0
        self.content_chunks: int = 0
        self.phase_events: list[PhaseEvent] = []
        self.status_events: list[str] = []
        self.reasoning_text: str = ""
        self.content_text: str = ""
        self.finish_reason: str = ""
        self.model_used: str = ""
        self.error: str | None = None

    @property
    def ttfe_ms(self) -> int:
        """Time to first event (any SSE data)."""
        if not self.time_first_event:
            return -1
        return int((self.time_first_event - self.time_request_sent) * 1000)

    @property
    def ttfr_ms(self) -> int:
        """Time to first reasoning token."""
        if not self.time_first_reasoning:
            return -1
        return int((self.time_first_reasoning - self.time_request_sent) * 1000)

    @property
    def ttfc_ms(self) -> int:
        """Time to first content token."""
        if not self.time_first_content:
            return -1
        return int((self.time_first_content - self.time_request_sent) * 1000)

    @property
    def reasoning_duration_ms(self) -> int:
        """Duration of reasoning phase (first reasoning token → first content token)."""
        if not self.time_first_reasoning:
            return 0
        end = self.time_first_content if self.time_first_content else self.time_last_reasoning
        if not end:
            return 0
        return int((end - self.time_first_reasoning) * 1000)

    @property
    def total_ms(self) -> int:
        if not self.time_complete:
            return -1
        return int((self.time_complete - self.time_request_sent) * 1000)

    @property
    def total_s(self) -> float:
        if not self.time_complete:
            return -1
        return round(self.time_complete - self.time_request_sent, 2)

    @property
    def had_reasoning(self) -> bool:
        return self.reasoning_chunks > 0

    @property
    def streamed(self) -> bool:
        return self.content_chunks > 1

    @property
    def duplicate_phases(self) -> list[str]:
        """Detect consecutive duplicate status descriptions (stacking)."""
        dupes = []
        prev = ""
        for pe in self.phase_events:
            if pe.description == prev and pe.description:
                dupes.append(pe.description)
            prev = pe.description
        return dupes

    @property
    def phase_count(self) -> int:
        return len([p for p in self.phase_events if p.description])

    @property
    def reasoning_content_ratio(self) -> float:
        """Ratio of reasoning tokens to content tokens (higher = more thinking)."""
        if not self.content_text:
            return 0.0
        return round(len(self.reasoning_text) / max(len(self.content_text), 1), 2)

    def to_dict(self) -> dict:
        return {
            "ttfe_ms": self.ttfe_ms,
            "ttfr_ms": self.ttfr_ms,
            "ttfc_ms": self.ttfc_ms,
            "reasoning_duration_ms": self.reasoning_duration_ms,
            "total_ms": self.total_ms,
            "total_s": self.total_s,
            "reasoning_chunks": self.reasoning_chunks,
            "content_chunks": self.content_chunks,
            "reasoning_len": len(self.reasoning_text),
            "content_len": len(self.content_text),
            "reasoning_content_ratio": self.reasoning_content_ratio,
            "phase_timeline": [p.to_dict() for p in self.phase_events],
            "phase_count": self.phase_count,
            "duplicate_phases": self.duplicate_phases,
            "status_events": self.status_events,
            "finish_reason": self.finish_reason,
            "model": self.model_used,
            "streamed": self.content_chunks > 1,
            "had_reasoning": self.reasoning_chunks > 0,
            "error": self.error,
        }


def send_prompt(
    client: httpx.Client,
    messages: list[dict],
    api_url: str,
    api_key: str,
    model: str,
) -> SSEMetrics:
    """Send a chat completion request with streaming and parse SSE response."""
    metrics = SSEMetrics()
    url = f"{api_url.rstrip('/')}/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": 0.2,
    }

    metrics.time_request_sent = time.monotonic()

    try:
        with client.stream("POST", url, json=payload, headers=headers, timeout=TIMEOUT_S) as resp:
            if resp.status_code != 200:
                metrics.error = f"HTTP {resp.status_code}"
                metrics.time_complete = time.monotonic()
                return metrics

            for line in resp.iter_lines():
                if not line or not line.startswith("data: "):
                    continue

                data_str = line[6:]
                if data_str.strip() == "[DONE]":
                    break

                now = time.monotonic()
                if not metrics.time_first_event:
                    metrics.time_first_event = now

                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                if not metrics.model_used:
                    metrics.model_used = chunk.get("model", "")

                # Check for status events (Open WebUI format)
                if chunk.get("type") == "status":
                    inner = chunk.get("data") or {}
                    desc = inner.get("description", "")
                    done = inner.get("done", False)
                    offset = int((now - metrics.time_request_sent) * 1000)
                    metrics.phase_events.append(PhaseEvent(desc, done, offset))
                    if desc:
                        metrics.status_events.append(desc)
                    continue

                choices = chunk.get("choices") or []
                if not choices:
                    continue

                delta = choices[0].get("delta") or {}
                fr = choices[0].get("finish_reason")
                if fr:
                    metrics.finish_reason = fr

                reasoning = delta.get("reasoning_content") or ""
                content = delta.get("content") or ""

                if reasoning:
                    metrics.reasoning_chunks += 1
                    metrics.reasoning_text += reasoning
                    metrics.time_last_reasoning = now
                    if not metrics.time_first_reasoning:
                        metrics.time_first_reasoning = now

                if content:
                    metrics.content_chunks += 1
                    metrics.content_text += content
                    if not metrics.time_first_content:
                        metrics.time_first_content = now

    except httpx.TimeoutException:
        metrics.error = f"Timeout after {TIMEOUT_S}s"
    except httpx.ConnectError as e:
        metrics.error = f"Connection error: {e}"
    except Exception as e:
        metrics.error = f"Unexpected: {type(e).__name__}: {e}"

    metrics.time_complete = time.monotonic()
    return metrics


def evaluate(prompt_spec: dict, metrics: SSEMetrics) -> dict:
    """Compare metrics against expected behavior. Returns verdict dict."""
    verdicts: list[dict] = []
    overall = "pass"

    def add(name: str, status: str, detail: str = ""):
        nonlocal overall
        verdicts.append({"check": name, "status": status, "detail": detail})
        if status == "fail" and overall != "fail":
            overall = "fail"
        elif status == "warn" and overall == "pass":
            overall = "warn"

    if metrics.error:
        add("no_error", "fail", metrics.error)
        return {"overall": "fail", "checks": verdicts}

    # Latency check
    max_s = prompt_spec.get("max_latency_s", 30)
    if metrics.total_s > max_s:
        add("latency", "fail", f"{metrics.total_s}s > {max_s}s limit")
    elif metrics.total_s > max_s * 0.8:
        add("latency", "warn", f"{metrics.total_s}s approaching {max_s}s limit")
    else:
        add("latency", "pass", f"{metrics.total_s}s")

    # Streaming check
    if prompt_spec.get("should_stream", True):
        if metrics.content_chunks > 1:
            add("streaming", "pass", f"{metrics.content_chunks} chunks")
        elif metrics.content_chunks == 1:
            add("streaming", "warn", "Single chunk (buffered?)")
        else:
            add("streaming", "warn", "No content chunks received")

    # Content check
    if metrics.content_text.strip():
        add("has_content", "pass", f"{len(metrics.content_text)} chars")
    else:
        add("has_content", "fail", "Empty response")

    # Output type heuristics (needs_sandbox: code vs explain)
    expected_deliv = prompt_spec.get("expected_deliverable", "")
    if expected_deliv == "explain_only":
        has_code_blocks = "```" in metrics.content_text
        if has_code_blocks and prompt_spec.get("category") not in ("review", "safety", "mixed"):
            add("output_type", "warn", "explain_only but response contains code blocks")
        else:
            add("output_type", "pass", "explain_only")
    elif expected_deliv in ("code_snippet", "code_project"):
        has_code = (
            "```" in metrics.content_text or "def " in metrics.content_text or "function " in metrics.content_text
        )
        if has_code:
            add("output_type", "pass", "Contains code")
        else:
            add("output_type", "warn", "Expected code but none detected in response")

    # ── Reasoning / thinking checks ──
    max_reasoning_s = _get_threshold(prompt_spec, "max_reasoning_s")
    max_ratio = _get_threshold(prompt_spec, "max_reasoning_ratio")
    dur_s = metrics.reasoning_duration_ms / 1000.0 if metrics.reasoning_duration_ms else 0
    ratio = metrics.reasoning_content_ratio

    if metrics.had_reasoning:
        detail = f"{metrics.reasoning_chunks} chunks, {metrics.reasoning_duration_ms}ms, ratio {ratio}x"

        if dur_s > max_reasoning_s:
            add(
                "overthinking",
                "warn",
                f"Reasoning {dur_s:.1f}s > {max_reasoning_s}s limit. {detail}",
            )
        else:
            add("reasoning_duration", "pass", f"{dur_s:.1f}s (limit {max_reasoning_s}s)")

        if ratio > max_ratio:
            add(
                "overthinking_ratio",
                "warn",
                f"Ratio {ratio}x > {max_ratio}x limit. {detail}",
            )
        else:
            add("reasoning_ratio", "pass", f"{ratio}x (limit {max_ratio}x)")
    else:
        cat = prompt_spec.get("category", "")
        if cat in ("multi_step", "code", "review", "mixed", "comparison"):
            add("underthinking", "warn", "No reasoning for a category that benefits from chain-of-thought")
        else:
            add("reasoning", "info", "No reasoning tokens observed")

    # ── Phase / pipeline checks ──
    expected_phases = prompt_spec.get("expected_phases")
    if not expected_phases:
        expected_phases = _derive_expected_phases(
            prompt_spec.get("expected_route", "worker"),
            prompt_spec.get("expected_deliverable", "explain_only"),
            prompt_spec.get("category", ""),
        )

    if metrics.phase_events:
        dupes = metrics.duplicate_phases
        if dupes:
            add("phase_duplicates", "warn", f"Stacked phases: {dupes[:5]}")
        else:
            add("phase_duplicates", "pass", f"{metrics.phase_count} unique phases")

        if expected_phases:
            seen = [p.description for p in metrics.phase_events if p.description]
            missing = [e for e in expected_phases if not any(e.lower() in s.lower() for s in seen)]
            if missing:
                add("expected_phases", "warn", f"Missing phases: {missing}")
            else:
                add("expected_phases", "pass", f"All {len(expected_phases)} expected phases seen")
    elif expected_phases:
        add("expected_phases", "warn", "No phase events received at all")

    return {"overall": overall, "checks": verdicts}


def run_batch(
    batch: list[dict],
    api_url: str,
    api_key: str,
    model: str,
    verbose: bool = False,
) -> list[dict]:
    """Run a batch of prompts (standalone or sequence). Returns results."""
    results = []
    messages: list[dict] = []

    with httpx.Client(http2=False, follow_redirects=True) as client:
        for i, spec in enumerate(batch):
            prompt_id = spec["id"]
            prompt_text = spec["prompt"]
            is_continuation = spec.get("sequence") and i > 0

            if not is_continuation:
                messages = []

            messages.append({"role": "user", "content": prompt_text})

            if verbose:
                seq_label = f" [{spec.get('sequence', '')}]" if spec.get("sequence") else ""
                print(f"  → {prompt_id}{seq_label}: {prompt_text[:60]}...", flush=True)

            metrics = send_prompt(client, messages, api_url, api_key, model)
            evaluation = evaluate(spec, metrics)

            # Append assistant response to conversation for multi-turn
            if metrics.content_text:
                messages.append({"role": "assistant", "content": metrics.content_text})

            result = {
                "id": prompt_id,
                "category": spec.get("category", ""),
                "sequence": spec.get("sequence"),
                "prompt_preview": prompt_text[:80],
                "verdict": evaluation["overall"],
                "checks": evaluation["checks"],
                "metrics": metrics.to_dict(),
                "expected": {
                    "route": spec.get("expected_route"),
                    "deliverable": spec.get("expected_deliverable"),
                    "lang": spec.get("expected_lang"),
                    "max_latency_s": spec.get("max_latency_s"),
                    "context_must_persist": spec.get("context_must_persist", False),
                },
            }
            results.append(result)

            status_icon = {"pass": "✓", "warn": "⚠", "fail": "✗"}.get(evaluation["overall"], "?")
            timing = f"{metrics.total_s}s" if metrics.total_s > 0 else "err"
            reason_info = ""
            if metrics.had_reasoning:
                reason_info = f" think:{metrics.reasoning_duration_ms}ms"
            phase_info = ""
            dupes = metrics.duplicate_phases
            if dupes:
                phase_info = f" STACKED:{len(dupes)}"
            print(
                f"  {status_icon} {prompt_id}: {evaluation['overall'].upper()} "
                f"({timing}, {metrics.content_chunks} chunks, "
                f"{len(metrics.content_text)} chars,"
                f" phases:{metrics.phase_count}{reason_info}{phase_info})",
                flush=True,
            )

    return results


def generate_report(all_results: list[dict], api_url: str, output_path: Path) -> dict:
    """Generate structured report."""
    summary = {"pass": 0, "warn": 0, "fail": 0}
    for r in all_results:
        summary[r["verdict"]] = summary.get(r["verdict"], 0) + 1

    category_breakdown: dict[str, dict] = defaultdict(
        lambda: {
            "pass": 0,
            "warn": 0,
            "fail": 0,
            "avg_latency_s": 0,
            "avg_reasoning_ms": 0,
            "avg_phases": 0,
            "stacked_count": 0,
            "count": 0,
        }
    )
    for r in all_results:
        cat = r["category"]
        category_breakdown[cat][r["verdict"]] += 1
        category_breakdown[cat]["count"] += 1
        m = r["metrics"]
        t = m.get("total_s", 0)
        if t > 0:
            category_breakdown[cat]["avg_latency_s"] += t
        category_breakdown[cat]["avg_reasoning_ms"] += m.get("reasoning_duration_ms", 0)
        category_breakdown[cat]["avg_phases"] += m.get("phase_count", 0)
        if m.get("duplicate_phases"):
            category_breakdown[cat]["stacked_count"] += 1

    for cat, data in category_breakdown.items():
        n = data["count"]
        if n > 0:
            data["avg_latency_s"] = round(data["avg_latency_s"] / n, 2)
            data["avg_reasoning_ms"] = round(data["avg_reasoning_ms"] / n)
            data["avg_phases"] = round(data["avg_phases"] / n, 1)

    # ── Tuning recommendations ──
    tuning: list[str] = []
    for cat, data in category_breakdown.items():
        n = data["count"]
        if n == 0:
            continue
        cat_defaults = CATEGORY_DEFAULTS.get(cat, _DEFAULT_CATEGORY)
        max_r_s = cat_defaults.get("max_reasoning_s", 10)

        if data["avg_reasoning_ms"] > max_r_s * 1000:
            tuning.append(
                f"{cat}: avg reasoning {data['avg_reasoning_ms']}ms exceeds "
                f"{max_r_s}s threshold — consider lowering token budget"
            )
        if data.get("stacked_count", 0) > 0:
            tuning.append(
                f"{cat}: {data['stacked_count']}/{n} prompts had stacked/duplicate phase events"
            )

        # Check for consistent underthinking in code-oriented categories
        reasoning_sum = sum(
            r["metrics"].get("reasoning_chunks", 0)
            for r in all_results
            if r["category"] == cat
        )
        if cat in ("code", "multi_step", "review", "mixed") and reasoning_sum == 0 and n > 0:
            tuning.append(
                f"{cat}: zero reasoning tokens across {n} prompts — "
                "model may not be engaging chain-of-thought"
            )

    report = {
        "metadata": {
            "timestamp": datetime.now(UTC).isoformat(),
            "api_url": api_url,
            "total_prompts": len(all_results),
        },
        "summary": summary,
        "category_breakdown": dict(category_breakdown),
        "tuning_recommendations": tuning,
        "failures": [r for r in all_results if r["verdict"] == "fail"],
        "warnings": [r for r in all_results if r["verdict"] == "warn"],
        "all_results": all_results,
    }

    with open(output_path, "w") as f:
        yaml.dump(report, f, default_flow_style=False, sort_keys=False, width=200, allow_unicode=True)

    return report


def print_summary(report: dict) -> None:
    s = report["summary"]
    total = s["pass"] + s["warn"] + s["fail"]
    print("\n" + "=" * 60)
    print("SYNESIS TEST SUITE REPORT")
    print("=" * 60)
    print(f"Total: {total}  |  Pass: {s['pass']}  |  Warn: {s['warn']}  |  Fail: {s['fail']}")
    print(f"Pass rate: {s['pass'] / total * 100:.0f}%") if total else None
    print()

    print("By category:")
    for cat, data in sorted(report["category_breakdown"].items()):
        p, w, f_ = data["pass"], data["warn"], data["fail"]
        avg = data["avg_latency_s"]
        avg_r = data.get("avg_reasoning_ms", 0)
        avg_ph = data.get("avg_phases", 0)
        stacked = data.get("stacked_count", 0)
        stacked_str = f"  stacked:{stacked}" if stacked else ""
        print(
            f"  {cat:20s}  P:{p} W:{w} F:{f_}  "
            f"avg:{avg}s  think:{avg_r}ms  phases:{avg_ph}{stacked_str}"
        )

    if report["failures"]:
        print(f"\n{'─' * 60}")
        print(f"FAILURES ({len(report['failures'])}):")
        for r in report["failures"]:
            print(f"  ✗ {r['id']}: {r['prompt_preview']}")
            for c in r["checks"]:
                if c["status"] == "fail":
                    print(f"      → {c['check']}: {c['detail']}")

    if report["warnings"]:
        print(f"\n{'─' * 60}")
        print(f"WARNINGS ({len(report['warnings'])}):")
        for r in report["warnings"]:
            print(f"  ⚠ {r['id']}: {r['prompt_preview']}")
            for c in r["checks"]:
                if c["status"] == "warn":
                    print(f"      → {c['check']}: {c['detail']}")

    tuning = report.get("tuning_recommendations", [])
    if tuning:
        print(f"\n{'─' * 60}")
        print(f"TUNING RECOMMENDATIONS ({len(tuning)}):")
        for t in tuning:
            print(f"  → {t}")

    print()


def main():
    parser = argparse.ArgumentParser(description="Synesis Prompt Test Harness")
    parser.add_argument(
        "--api-url",
        default=DEFAULT_API_URL,
        help=f"Planner API base URL (default: {DEFAULT_API_URL})",
    )
    parser.add_argument(
        "--api-key",
        default=DEFAULT_API_KEY,
        help="API key for authentication",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"Model name to send in requests (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--suite",
        type=Path,
        default=SUITE_PATH,
        help="Path to test suite YAML",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output report path (default: test_report_<timestamp>.yaml)",
    )
    parser.add_argument(
        "--category",
        nargs="*",
        help="Only run prompts from these categories",
    )
    parser.add_argument(
        "--ids",
        nargs="*",
        help="Only run specific prompt IDs",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate suite and show execution plan without sending requests",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Show prompt text before sending",
    )
    parser.add_argument(
        "--pause",
        type=float,
        default=1.0,
        help="Seconds to pause between batches (default: 1.0)",
    )
    args = parser.parse_args()

    # Load suite (accept old filename as fallback)
    if not args.suite.exists():
        fallback = args.suite.parent / "test_prompts_100.yaml"
        if fallback.exists():
            args.suite = fallback
        else:
            sys.exit(f"Suite file not found: {args.suite}")
    prompts = load_suite(args.suite)
    print(f"Loaded {len(prompts)} prompts from {args.suite}")

    # Filter
    if args.ids:
        prompts = [p for p in prompts if p["id"] in args.ids]
        print(f"Filtered to {len(prompts)} prompts by ID")
    elif args.category:
        prompts = [p for p in prompts if p.get("category") in args.category]
        print(f"Filtered to {len(prompts)} prompts by category: {', '.join(args.category)}")

    if not prompts:
        sys.exit("No prompts to run after filtering.")

    # Group into execution batches
    batches = group_sequences(prompts)
    total_batches = len(batches)
    total_prompts = sum(len(b) for b in batches)
    print(f"Execution plan: {total_prompts} prompts in {total_batches} batches")

    categories = sorted(set(p.get("category", "?") for p in prompts))
    print(f"Categories: {', '.join(categories)}")

    if args.dry_run:
        print("\n--- DRY RUN ---")
        for i, batch in enumerate(batches):
            seq = batch[0].get("sequence")
            label = f"sequence '{seq.split(':')[0]}'" if seq else "standalone"
            print(f"\nBatch {i + 1} ({label}):")
            for p in batch:
                print(f"  {p['id']:15s} [{p.get('category', '?'):12s}] {p['prompt'][:65]}")
        print(f"\nTotal: {total_prompts} prompts, {total_batches} batches")
        return

    # Validate connectivity
    print(f"\nTarget: {args.api_url}")
    try:
        with httpx.Client(follow_redirects=True) as c:
            r = c.get(
                f"{args.api_url.rstrip('/')}/v1/models", headers={"Authorization": f"Bearer {args.api_key}"}, timeout=10
            )
            if r.status_code == 200:
                models = r.json().get("data", [])
                model_ids = [m.get("id", "") for m in models]
                print(f"Connected. Available models: {', '.join(model_ids)}")
            else:
                print(f"Warning: /v1/models returned {r.status_code}. Continuing anyway.")
    except Exception as e:
        print(f"Warning: Could not reach {args.api_url}: {e}")
        print("Continuing — requests may fail.")

    # Run
    print(f"\n{'=' * 60}")
    print(f"RUNNING {total_prompts} PROMPTS")
    print(f"{'=' * 60}\n")

    all_results: list[dict] = []
    for i, batch in enumerate(batches):
        seq = batch[0].get("sequence")
        if seq:
            group_id = seq.split(":")[0]
            print(f"\n[Batch {i + 1}/{total_batches}] Sequence: {group_id} ({len(batch)} turns)")
        else:
            print(f"\n[Batch {i + 1}/{total_batches}] {batch[0]['id']}")

        results = run_batch(batch, args.api_url, args.api_key, args.model, verbose=args.verbose)
        all_results.extend(results)

        if i < total_batches - 1:
            time.sleep(args.pause)

    # Report
    output_path = args.output or Path(f"test_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.yaml")
    report = generate_report(all_results, args.api_url, output_path)
    print_summary(report)
    print(f"Full report: {output_path}")


if __name__ == "__main__":
    main()
