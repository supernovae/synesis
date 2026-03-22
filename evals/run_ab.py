#!/usr/bin/env python3
"""Full vs Selective A/B evaluation runner.

Sends benchmark prompts to the Synesis planner in both inference modes,
collects latency/cost/quality metrics, runs deterministic checks, and
optionally sends paired responses to an external LLM judge.

Usage:
    python evals/run_ab.py \
        --prompts evals/benchmark_prompts.yaml \
        --rubric evals/judge_rubric.yaml \
        --planner-url http://localhost:8000/v1/chat/completions \
        --judge-url https://openrouter.ai/api/v1 \
        --judge-api-key $OPENROUTER_API_KEY \
        --output evals/results/ \
        --buckets easy,medium,hard

    # Dry run (no judge, just collect responses + deterministic checks):
    python evals/run_ab.py --prompts ... --planner-url ... --no-judge
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import yaml


def load_yaml(path: str) -> dict[str, Any]:
    with open(path) as f:
        return yaml.safe_load(f)


def send_prompt(
    planner_url: str,
    prompt: str,
    inference_mode: str,
    timeout: float = 300.0,
) -> dict[str, Any]:
    """Send a streaming prompt to the planner and reconstruct the response.

    The planner is SSE-streaming-only for proper results (trivial tasks use a
    direct_stream_request pattern that only fires in streaming mode).
    """
    headers = {
        "Content-Type": "application/json",
        "X-Synesis-Inference-Mode": inference_mode,
    }
    payload = {
        "model": "synesis-agent",
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
    }

    t0 = time.monotonic()
    content_parts: list[str] = []
    usage: dict[str, int] = {}
    status_code = 0
    try:
        with httpx.Client(timeout=timeout) as client:
            with client.stream("POST", planner_url, json=payload, headers=headers) as resp:
                status_code = resp.status_code
                resp.raise_for_status()
                for line in resp.iter_lines():
                    if not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str.strip() == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue

                    chunk_usage = chunk.get("usage")
                    if chunk_usage:
                        usage = chunk_usage

                    for choice in chunk.get("choices", []):
                        delta = choice.get("delta", {})
                        tok = delta.get("content", "")
                        if tok:
                            content_parts.append(tok)

        elapsed_ms = (time.monotonic() - t0) * 1000
        content = "".join(content_parts)
        return {
            "content": content,
            "elapsed_ms": round(elapsed_ms, 1),
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
            "total_tokens": usage.get("total_tokens", 0),
            "status_code": status_code,
            "error": None,
        }
    except Exception as exc:
        elapsed_ms = (time.monotonic() - t0) * 1000
        return {
            "content": "".join(content_parts),
            "elapsed_ms": round(elapsed_ms, 1),
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "status_code": status_code,
            "error": str(exc)[:500],
        }


def run_deterministic_checks(
    content: str,
    prompt_meta: dict[str, Any],
    checks_config: dict[str, Any],
) -> dict[str, bool]:
    """Run regex-based deterministic checks on a response."""
    results: dict[str, bool] = {}
    bucket = prompt_meta.get("bucket", "")
    capabilities = prompt_meta.get("capabilities", [])
    must_pass = prompt_meta.get("must_pass", [])

    for check_name, check_def in checks_config.items():
        applies = check_def.get("applies_when", "never")

        should_run = False
        if applies == "always":
            should_run = True
        elif "capabilities" in applies:
            cap_match = re.search(r"(\w+) in capabilities", applies)
            if cap_match and cap_match.group(1) in capabilities:
                should_run = True
        elif "must_pass" in applies:
            mp_match = re.search(r"(\w+) in must_pass", applies)
            if mp_match and mp_match.group(1) in must_pass:
                should_run = True
        elif "bucket" in applies:
            for b in ("easy", "medium", "hard"):
                if b in applies and b == bucket:
                    should_run = True

        if not should_run:
            continue

        if "regex_must_not_match" in check_def:
            pattern = check_def["regex_must_not_match"]
            results[check_name] = not bool(re.search(pattern, content, re.MULTILINE))
        elif "regex" in check_def:
            pattern = check_def["regex"]
            results[check_name] = bool(re.search(pattern, content, re.MULTILINE))

    return results


def judge_pair(
    judge_url: str,
    judge_api_key: str,
    judge_model: str,
    prompt_text: str,
    response_a: str,
    response_b: str,
    rubric: dict[str, Any],
    prompt_meta: dict[str, Any],
) -> dict[str, Any] | None:
    """Send paired responses to the external judge and parse scores."""
    dims = rubric.get("dimensions", {})
    template = rubric.get("judge_prompt_template", "")

    must_pass_checks = rubric.get("must_pass_checks", {})
    applicable_checks = []
    bucket = prompt_meta.get("bucket", "")
    capabilities = prompt_meta.get("capabilities", [])
    for name, check in must_pass_checks.items():
        applies = check.get("applies_when", "never")
        if applies == "always":
            applicable_checks.append(f"- {name}: {check['description']}")
        elif "capabilities" in applies:
            cap_match = re.search(r"(\w+) in capabilities", applies)
            if cap_match and cap_match.group(1) in capabilities:
                applicable_checks.append(f"- {name}: {check['description']}")
        elif "bucket" in applies and bucket in applies:
            applicable_checks.append(f"- {name}: {check['description']}")

    must_pass_section = "\n".join(applicable_checks) if applicable_checks else "None applicable."

    replacements = {
        "prompt": prompt_text,
        "response_a": response_a[:15000],
        "response_b": response_b[:15000],
        "dim_instruction_satisfaction": dims.get("instruction_satisfaction", {}).get("description", ""),
        "dim_factual_grounding": dims.get("factual_grounding", {}).get("description", ""),
        "dim_uncertainty_handling": dims.get("uncertainty_handling", {}).get("description", ""),
        "dim_completeness_vs_concision": dims.get("completeness_vs_concision", {}).get("description", ""),
        "dim_harmful_overconfidence": dims.get("harmful_overconfidence", {}).get("description", ""),
        "must_pass_section": must_pass_section,
    }
    judge_prompt = template
    for key, value in replacements.items():
        judge_prompt = judge_prompt.replace("{" + key + "}", str(value))

    try:
        with httpx.Client(timeout=120) as client:
            resp = client.post(
                f"{judge_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {judge_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": judge_model,
                    "messages": [{"role": "user", "content": judge_prompt}],
                    "temperature": 0.1,
                    "max_tokens": 2048,
                    "response_format": {"type": "json_object"},
                },
            )
            resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"]["content"]

            json_match = re.search(r"\{.*\}", raw, re.DOTALL)
            if json_match:
                return json.loads(json_match.group())
            return json.loads(raw)
    except Exception as exc:
        print(f"  [WARN] Judge call failed: {exc}", file=sys.stderr)
        return None


def compute_weighted_score(scores: dict[str, int], dimensions: dict[str, Any]) -> float:
    total = 0.0
    weight_sum = 0.0
    for dim_name, dim_def in dimensions.items():
        w = dim_def.get("weight", 0.0)
        s = scores.get(dim_name, 5)
        total += w * s
        weight_sum += w
    return round(total / max(weight_sum, 0.01), 2)


def main() -> None:
    parser = argparse.ArgumentParser(description="Full vs Selective A/B evaluation runner")
    parser.add_argument("--prompts", required=True, help="Path to benchmark_prompts.yaml")
    parser.add_argument("--rubric", default="evals/judge_rubric.yaml", help="Path to judge_rubric.yaml")
    parser.add_argument("--planner-url", required=True, help="Synesis planner chat completions URL")
    parser.add_argument("--judge-url", default="https://openrouter.ai/api/v1", help="Judge LLM API base URL")
    parser.add_argument("--judge-api-key", default="", help="API key for judge model")
    parser.add_argument("--output", default="evals/results", help="Output directory for results")
    parser.add_argument("--buckets", default="easy,medium,hard", help="Comma-separated buckets to run")
    parser.add_argument("--no-judge", action="store_true", help="Skip external judge (deterministic checks only)")
    parser.add_argument("--timeout", type=float, default=300.0, help="Per-request timeout in seconds")
    parser.add_argument("--ids", default="", help="Comma-separated prompt IDs to run (empty = all)")
    args = parser.parse_args()

    prompts_data = load_yaml(args.prompts)
    rubric = load_yaml(args.rubric) if not args.no_judge else {}

    all_prompts = prompts_data["prompts"]
    buckets = set(args.buckets.split(","))
    selected_ids = set(args.ids.split(",")) if args.ids else set()

    prompts = [p for p in all_prompts if p["bucket"] in buckets and (not selected_ids or p["id"] in selected_ids)]

    print(f"Running {len(prompts)} prompts across modes: full, selective")
    print(f"Planner URL: {args.planner_url}")
    print(f"Judge: {'disabled' if args.no_judge else rubric.get('judge_model', 'unknown')}")
    print()

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    run_id = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    results: list[dict[str, Any]] = []
    det_checks_config = rubric.get("deterministic_checks", {}) if rubric else {}
    dimensions = rubric.get("dimensions", {}) if rubric else {}
    _raw_judge_model = rubric.get("judge_model", "openrouter/anthropic/claude-sonnet-4") if rubric else ""
    judge_model = _raw_judge_model.removeprefix("openrouter/")

    for i, prompt_meta in enumerate(prompts):
        pid = prompt_meta["id"]
        bucket = prompt_meta["bucket"]
        prompt_text = prompt_meta["prompt"]
        print(f"[{i + 1}/{len(prompts)}] {pid} ({bucket})")

        # Run both modes
        modes = {}
        for mode in ("full", "selective"):
            print(f"  -> {mode}...", end="", flush=True)
            resp = send_prompt(args.planner_url, prompt_text, mode, timeout=args.timeout)
            modes[mode] = resp
            status = "OK" if not resp["error"] else f"ERR: {resp['error'][:60]}"
            chars = len(resp["content"])
            print(f" {resp['elapsed_ms']:.0f}ms, {chars}ch, {resp['total_tokens']}tok [{status}]")

        # Deterministic checks
        det_results = {}
        for mode in ("full", "selective"):
            det_results[mode] = run_deterministic_checks(modes[mode]["content"], prompt_meta, det_checks_config)

        # External judge (blinded)
        judge_result = None
        if not args.no_judge and args.judge_api_key:
            # Randomly assign A/B labels to prevent ordering bias
            if random.random() < 0.5:
                a_mode, b_mode = "full", "selective"
            else:
                a_mode, b_mode = "selective", "full"

            print("  -> judging...", end="", flush=True)
            judge_result = judge_pair(
                judge_url=args.judge_url,
                judge_api_key=args.judge_api_key,
                judge_model=judge_model,
                prompt_text=prompt_text,
                response_a=modes[a_mode]["content"],
                response_b=modes[b_mode]["content"],
                rubric=rubric,
                prompt_meta=prompt_meta,
            )

            if judge_result:
                # De-blind: map A/B back to full/selective
                judge_result["mode_map"] = {"A": a_mode, "B": b_mode}
                preferred_raw = judge_result.get("preferred", "tie")
                if preferred_raw == "A":
                    judge_result["preferred_mode"] = a_mode
                elif preferred_raw == "B":
                    judge_result["preferred_mode"] = b_mode
                else:
                    judge_result["preferred_mode"] = "tie"

                # Compute weighted scores
                for label in ("response_a", "response_b"):
                    scores = judge_result.get(label, {})
                    judge_result.setdefault(label, {})["weighted_score"] = compute_weighted_score(scores, dimensions)

                print(f" preferred={judge_result['preferred_mode']}")
            else:
                print(" failed")

        result = {
            "id": pid,
            "bucket": bucket,
            "corpus_slice": prompt_meta["corpus_slice"],
            "capabilities": prompt_meta["capabilities"],
            "must_pass": prompt_meta.get("must_pass", []),
            "modes": {
                mode: {
                    "elapsed_ms": modes[mode]["elapsed_ms"],
                    "prompt_tokens": modes[mode]["prompt_tokens"],
                    "completion_tokens": modes[mode]["completion_tokens"],
                    "total_tokens": modes[mode]["total_tokens"],
                    "error": modes[mode]["error"],
                    "response_length": len(modes[mode]["content"]),
                    "content": modes[mode]["content"],
                    "deterministic_checks": det_results[mode],
                }
                for mode in ("full", "selective")
            },
            "judge": judge_result,
        }
        results.append(result)

    # Write results
    results_path = out_dir / f"ab_results_{run_id}.json"
    with open(results_path, "w") as f:
        json.dump({"run_id": run_id, "total": len(results), "results": results}, f, indent=2)
    print(f"\nResults written to {results_path}")

    # Write responses (for manual review)
    responses_dir = out_dir / f"responses_{run_id}"
    responses_dir.mkdir(exist_ok=True)
    for prompt_meta, result in zip(prompts, results):
        pid = result["id"]
        for mode in ("full", "selective"):
            resp_path = responses_dir / f"{pid}_{mode}.md"
            content = result["modes"][mode].get("content", "")
            with open(resp_path, "w") as f:
                f.write(f"# {pid} ({mode})\n\n")
                f.write(f"Prompt: {prompt_meta['prompt'][:200]}...\n\n---\n\n")
                f.write(content if content else "[ERROR/EMPTY]")

    # Print summary
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)

    for bucket_name in ("easy", "medium", "hard"):
        bucket_results = [r for r in results if r["bucket"] == bucket_name]
        if not bucket_results:
            continue

        print(f"\n### {bucket_name.upper()} ({len(bucket_results)} prompts)")

        for mode in ("full", "selective"):
            latencies = [r["modes"][mode]["elapsed_ms"] for r in bucket_results if not r["modes"][mode]["error"]]
            tokens = [r["modes"][mode]["total_tokens"] for r in bucket_results if not r["modes"][mode]["error"]]
            errors = sum(1 for r in bucket_results if r["modes"][mode]["error"])

            if latencies:
                latencies.sort()
                p50 = latencies[len(latencies) // 2]
                p95 = latencies[int(len(latencies) * 0.95)]
                avg_tok = sum(tokens) / len(tokens) if tokens else 0
                print(f"  {mode:10s}: p50={p50:.0f}ms  p95={p95:.0f}ms  avg_tok={avg_tok:.0f}  errors={errors}")

        # Judge preferences
        if any(r["judge"] for r in bucket_results):
            full_wins = sum(1 for r in bucket_results if r["judge"] and r["judge"].get("preferred_mode") == "full")
            selective_wins = sum(
                1 for r in bucket_results if r["judge"] and r["judge"].get("preferred_mode") == "selective"
            )
            ties = sum(1 for r in bucket_results if r["judge"] and r["judge"].get("preferred_mode") == "tie")
            print(f"  Judge: full={full_wins}  selective={selective_wins}  tie={ties}")

    # Deterministic check summary
    print("\n### DETERMINISTIC CHECKS")
    for mode in ("full", "selective"):
        all_checks: dict[str, list[bool]] = {}
        for r in results:
            for check_name, passed in r["modes"][mode]["deterministic_checks"].items():
                all_checks.setdefault(check_name, []).append(passed)
        print(f"  {mode}:")
        for check_name, vals in sorted(all_checks.items()):
            pass_rate = sum(vals) / len(vals) * 100
            print(f"    {check_name}: {pass_rate:.0f}% ({sum(vals)}/{len(vals)})")


if __name__ == "__main__":
    main()
