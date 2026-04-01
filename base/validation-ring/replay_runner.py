#!/usr/bin/env python3
"""Testing Labs replay runner — executes inside a K8s Job in the validation ring.

Fetches run config from the admin API, replays prompts against the planner,
scores results, and reports back to admin.

Usage (in-cluster):
    python replay_runner.py --run-id tl-abc123 \
        --planner-url http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080 \
        --admin-url http://synesis-admin.synesis-admin.svc.cluster.local:8080
"""

from __future__ import annotations

import argparse
import re
import sys
import time

import httpx

TIMEOUT_S = 120


def fetch_run(admin_url: str, run_id: str, api_key: str) -> dict:
    headers = _auth_headers(api_key)
    resp = httpx.get(f"{admin_url}/api/v1/testing-labs/runs/{run_id}", headers=headers, timeout=15)
    resp.raise_for_status()
    return resp.json()


def fetch_traces(admin_url: str, limit: int, api_key: str) -> list[dict]:
    headers = _auth_headers(api_key)
    resp = httpx.get(
        f"{admin_url}/api/v1/traces",
        params={"limit": limit},
        headers=headers,
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    return data.get("traces", [])


def replay_prompt(planner_url: str, prompt: str, model: str, api_key: str) -> dict:
    """Send a single prompt and collect timing + content metrics."""
    url = f"{planner_url.rstrip('/')}/v1/chat/completions"
    headers = _auth_headers(api_key)
    headers["Content-Type"] = "application/json"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "temperature": 0.2,
        "max_tokens": 4096,
    }

    t0 = time.monotonic()
    try:
        resp = httpx.post(url, json=payload, headers=headers, timeout=TIMEOUT_S)
        latency_ms = (time.monotonic() - t0) * 1000
        if resp.status_code != 200:
            return {"error": f"HTTP {resp.status_code}", "latency_ms": latency_ms}
        data = resp.json()
        choices = data.get("choices", [])
        content = choices[0]["message"]["content"] if choices else ""
        usage = data.get("usage", {})
        tokens = usage.get("total_tokens", 0)
        citation_count = len(re.findall(r"\[.*?\]\(https?://.*?\)", content))
        return {
            "content": content,
            "latency_ms": round(latency_ms, 1),
            "tokens": tokens,
            "citation_count": citation_count,
        }
    except Exception as e:
        latency_ms = (time.monotonic() - t0) * 1000
        return {"error": str(e), "latency_ms": round(latency_ms, 1)}


def evaluate_response(result: dict) -> str:
    if result.get("error"):
        return "fail"
    content = result.get("content", "")
    if not content.strip():
        return "fail"
    return "pass"


def report_results(admin_url: str, run_id: str, results: list[dict], api_key: str) -> None:
    """POST results back to admin (batch upsert not yet implemented; update run metrics)."""
    headers = _auth_headers(api_key)
    headers["Content-Type"] = "application/json"

    n = len(results)
    completed = sum(
        1 for r in results if r.get("baseline", {}).get("verdict") and r.get("candidate", {}).get("verdict")
    )
    failed = sum(
        1
        for r in results
        if r.get("baseline", {}).get("verdict") == "fail" or r.get("candidate", {}).get("verdict") == "fail"
    )

    payload = {
        "status": "completed",
        "total_prompts": n,
        "completed_prompts": completed,
        "failed_prompts": failed,
        "results_summary": results[:5],
    }

    try:
        httpx.patch(
            f"{admin_url}/api/v1/testing-labs/runs/{run_id}/complete",
            json=payload,
            headers=headers,
            timeout=15,
        )
    except Exception as e:
        print(f"[replay] Warning: could not report results: {e}", file=sys.stderr)


def _auth_headers(api_key: str) -> dict[str, str]:
    h: dict[str, str] = {}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


def main() -> int:
    parser = argparse.ArgumentParser(description="Testing Labs replay runner")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--planner-url", default="http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080")
    parser.add_argument("--admin-url", default="http://synesis-admin.synesis-admin.svc.cluster.local:8080")
    parser.add_argument("--api-key", default="")
    args = parser.parse_args()

    print(f"[replay] Starting run {args.run_id}")

    run = fetch_run(args.admin_url, args.run_id, args.api_key)
    baseline_model = run.get("baseline_model", "synesis-agent")
    candidate_model = run.get("candidate_model", "synesis-agent")
    run_type = run.get("run_type", "replay")

    if run_type == "replay":
        traces = fetch_traces(args.admin_url, limit=50, api_key=args.api_key)
        prompts = [t.get("query_snippet", "")[:2000] for t in traces if t.get("query_snippet")]
    else:
        prompts = ["What is Kubernetes?", "Explain circuit breaker pattern", "How does RAG work?"]

    if not prompts:
        print("[replay] No prompts to replay")
        return 0

    print(f"[replay] Running {len(prompts)} prompts: baseline={baseline_model}, candidate={candidate_model}")
    results = []

    for i, prompt in enumerate(prompts):
        print(f"  [{i + 1}/{len(prompts)}] {prompt[:60]}...")

        baseline = replay_prompt(args.planner_url, prompt, baseline_model, args.api_key)
        baseline["verdict"] = evaluate_response(baseline)

        candidate = replay_prompt(args.planner_url, prompt, candidate_model, args.api_key)
        candidate["verdict"] = evaluate_response(candidate)

        results.append(
            {
                "prompt_index": i,
                "prompt_text": prompt[:500],
                "baseline": {
                    "latency_ms": baseline.get("latency_ms", 0),
                    "tokens": baseline.get("tokens", 0),
                    "citation_count": baseline.get("citation_count", 0),
                    "verdict": baseline["verdict"],
                },
                "candidate": {
                    "latency_ms": candidate.get("latency_ms", 0),
                    "tokens": candidate.get("tokens", 0),
                    "citation_count": candidate.get("citation_count", 0),
                    "verdict": candidate["verdict"],
                },
            }
        )

    report_results(args.admin_url, args.run_id, results, args.api_key)

    bl_pass = sum(1 for r in results if r["baseline"]["verdict"] == "pass")
    cd_pass = sum(1 for r in results if r["candidate"]["verdict"] == "pass")
    print(f"\n[replay] Done: baseline {bl_pass}/{len(results)} pass, candidate {cd_pass}/{len(results)} pass")

    if cd_pass < bl_pass:
        print("[replay] WARNING: Candidate regressed vs baseline")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
