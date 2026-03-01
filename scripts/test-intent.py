#!/usr/bin/env python3
"""Synesis Intent Stress-Tester — Governance Simulator for EntryClassifier.

Runs prompts through the ScoringEngine to see task_size, score, and hits.
Use to tune intent_weights.yaml until classifications match your standards.

Modes:
  1. Local (default): ScoringEngine only — no network, runs in ~1-2ms per prompt.
  2. Live (--live): POST to planner API, compare classifier output if available.

Usage:
  # Local: run built-in benchmarks (no deployment needed)
  python scripts/test-intent.py

  # Local: use custom prompts from YAML
  python scripts/test-intent.py --prompts base/planner/tests/validation_prompts.yaml

  # Local: single prompt
  python scripts/test-intent.py --prompt "print hello world"

  # Local: custom weights file
  python scripts/test-intent.py --config base/planner/intent_weights.yaml

  # Live: validate against deployed planner (requires port-forward or URL)
  python scripts/test-intent.py --live --url http://localhost:8000

Requires: pyyaml (pip install pyyaml). For --live, also needs httpx.

Recommended (uses scripts venv):
  PYTHONPATH=base/planner ./scripts/.venv/bin/python scripts/test-intent.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Add planner package root for 'from app.entry_classifier_engine import ...'
PROJECT_ROOT = Path(__file__).resolve().parent.parent
PLANNER_ROOT = PROJECT_ROOT / "base/planner"
if str(PLANNER_ROOT) not in sys.path:
    sys.path.insert(0, str(PLANNER_ROOT))

# Built-in benchmark prompts (various risk levels)
BENCHMARK_PROMPTS = [
    ("print hello world", "Trivial"),
    ("parse this json file and count the items", "Small"),
    ("How do I optimize a python loop?", "Educational / Trivial"),
    ("Deploy a flask app to OpenShift with SCC restricted", "Complex"),
    ("Wipe the production database", "High-Risk Pair"),
    ("Explain how S3 buckets work", "Educational / Small"),
    ("Write a script to read a CSV and post to an API", "Cross-Domain Density"),
    ("[STRICT] Show me a hello world", "Manual Override"),
    ("rotate my aws iam keys and update vault", "Complex / Security"),
    ("hello world in python", "Trivial"),
    ("add error handling to this function", "Small"),
    ("design the architecture for our microservices migration", "Complex"),
]


def load_prompts_from_yaml(path: Path) -> list[tuple[str, str]]:
    """Load prompts from validation_prompts.yaml. Returns [(prompt, label), ...]."""
    try:
        import yaml

        with open(path) as f:
            data = yaml.safe_load(f)
        items = data.get("prompts", [])
        return [(p["prompt"], p.get("expected", {}).get("task_size", "?")) for p in items]
    except Exception as e:
        print(f"Warning: Could not load {path}: {e}", file=sys.stderr)
        return []


def run_local(engine, prompts: list[tuple[str, str]], verbose: bool) -> int:
    """Run prompts through ScoringEngine. Returns exit code."""
    width = min(52, max(len(p[0]) for p in prompts) + 2)
    print(f"{'PROMPT':<{width}} | {'SIZE':<8} | {'SCORE':<5} | {'MODE':<6} | HITS")
    print("-" * (width + 60))

    for prompt, _ in prompts:
        result = engine.analyze(prompt)
        size = result["task_size"]
        score = result["score"]
        mode = result.get("interaction_mode", "do")
        hits = ", ".join(result.get("classification_hits", []))[:50]
        if verbose:
            cats = result.get("categories_touched", [])
            hits = f"{hits} [cats: {cats}]"
        print(f"{prompt[:width-2]:<{width}} | {size:<8} | {score:<5} | {mode:<6} | {hits}")

    return 0


def run_live(url: str, prompts: list[tuple[str, str]], verbose: bool) -> int:
    """POST prompts to planner. Returns exit code."""
    api_url = f"{url.rstrip('/')}/v1/chat/completions"
    print(f"Live mode: posting to {api_url}")
    print("(Planner may not expose raw intent; this validates full pipeline.)")
    print()

    try:
        import httpx
    except ImportError:
        print("Error: httpx required for --live. pip install httpx", file=sys.stderr)
        return 1

    failed = 0
    for prompt, _ in prompts:
        payload = {
            "model": "synesis-agent",
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
        }
        try:
            with httpx.Client(timeout=60.0) as client:
                resp = client.post(api_url, json=payload)
            if resp.status_code == 200:
                content = resp.json().get("choices", [{}])[0].get("message", {}).get("content", "")
                preview = content[:80].replace("\n", " ") + "..." if len(content) > 80 else content
                print(f"  ✓ [{prompt[:45]}...] -> {preview}")
                if verbose:
                    print(f"      Full: {content[:300]}...")
            else:
                print(f"  ✗ [{prompt[:45]}...] HTTP {resp.status_code}")
                failed += 1
        except Exception as e:
            print(f"  ✗ [{prompt[:45]}...] {e}")
            failed += 1

    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Intent Stress-Tester: run prompts through ScoringEngine or live planner.",
        epilog="Local mode needs no deployment. Use --live to validate against a running planner.",
    )
    parser.add_argument(
        "--config",
        default=None,
        help="Path to intent_weights.yaml (default: intent_weights or entry_classifier_weights)",
    )
    parser.add_argument(
        "--prompts",
        default=None,
        help="YAML file with prompts (validation_prompts.yaml format)",
    )
    parser.add_argument(
        "--prompt",
        default=None,
        help="Single prompt to test",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="POST to live planner API instead of local ScoringEngine",
    )
    parser.add_argument(
        "--url",
        default="http://localhost:8000",
        help="Planner base URL for --live (default: http://localhost:8000)",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Verbose output",
    )
    args = parser.parse_args()

    # Resolve prompts
    if args.prompt:
        prompts = [(args.prompt, "custom")]
    elif args.prompts:
        path = Path(args.prompts)
        if not path.is_absolute():
            path = PROJECT_ROOT / path
        prompts = load_prompts_from_yaml(path)
        if not prompts:
            print(f"No prompts loaded from {path}", file=sys.stderr)
            return 1
    else:
        prompts = BENCHMARK_PROMPTS

    if args.live:
        return run_live(args.url, prompts, args.verbose)

    # Local: load ScoringEngine
    try:
        from app.entry_classifier_engine import ScoringEngine, reset_scoring_engine

        reset_scoring_engine()
        config_path = Path(args.config) if args.config else None
        if config_path and not config_path.is_absolute():
            config_path = PROJECT_ROOT / config_path
        engine = ScoringEngine(config_path)
    except ImportError as e:
        print("Error: Cannot import ScoringEngine.", file=sys.stderr)
        print("  Install deps: pip install pyyaml  (or use base/planner venv)", file=sys.stderr)
        print("  Run: PYTHONPATH=base/planner python scripts/test-intent.py", file=sys.stderr)
        print(f"  {e}", file=sys.stderr)
        return 1

    print(f"Config: {engine._config.get('thresholds', {})}")
    print()
    return run_local(engine, prompts, args.verbose)


if __name__ == "__main__":
    sys.exit(main())
