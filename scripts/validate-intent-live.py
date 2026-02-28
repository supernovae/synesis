#!/usr/bin/env python3
"""Validate intent flow against live planner API (oc port-forward / tunnel).

Hits /v1/chat/completions with canonical prompts and asserts on response shape.
Use after push+deploy to regression-test behavior against the release you want.

Usage:
  # 1. Deploy your release to cluster
  # 2. Tunnel to planner:
  oc port-forward svc/synesis-planner 8000:8000 -n synesis-planner

  # 3. Run validation (in another terminal):
  python scripts/validate-intent-live.py
  python scripts/validate-intent-live.py --url http://localhost:8000
  python scripts/validate-intent-live.py --url https://synesis-planner.apps.your-cluster.example.com

Requires: httpx (pip install httpx) or requests. PyYAML for integration_prompts.yaml.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Minimal inline prompts if yaml unavailable
INLINE_PROMPTS = [
    {
        "prompt": "hello world in python",
        "response_must_contain": ["```python", "print"],
        "response_must_not_contain": ["I need more", "clarification"],
    },
    {
        "prompt": "suggest 3-5 follow-up questions",
        "response_must_contain": ["[UI helper request]", "no coding task"],
        "response_must_not_contain": ["```python"],
    },
]


def load_prompts() -> list[dict]:
    path = Path(__file__).parent.parent / "base/planner/tests/integration_prompts.yaml"
    if path.exists():
        try:
            import yaml

            with open(path) as f:
                data = yaml.safe_load(f)
            return data.get("prompts", INLINE_PROMPTS)
        except Exception:
            pass
    return INLINE_PROMPTS


def post_chat(url: str, prompt: str) -> tuple[str, int]:
    """POST to /v1/chat/completions. Returns (content, status_code)."""
    payload = {
        "model": "synesis-agent",
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
    }
    api_url = f"{url.rstrip('/')}/v1/chat/completions"

    try:
        import httpx

        with httpx.Client(timeout=120.0) as client:
            resp = client.post(api_url, json=payload)
            if resp.status_code == 200:
                content = resp.json().get("choices", [{}])[0].get("message", {}).get("content", "")
            else:
                content = resp.text
            return content, resp.status_code
    except ImportError:
        import urllib.request
        import urllib.error

        try:
            req = urllib.request.Request(
                api_url,
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode())
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                return content, resp.status
        except urllib.error.HTTPError as e:
            body = e.read().decode() if e.fp else str(e)
            return body, e.code
        except Exception as e:
            return f"ERROR: {e}", 0


def main():
    parser = argparse.ArgumentParser(
        description="Validate intent flow against live planner API.",
        epilog="Prerequisite: oc port-forward svc/synesis-planner 8000:8000 -n synesis-planner",
    )
    parser.add_argument(
        "--url",
        default="http://localhost:8000",
        help="Planner base URL (default: http://localhost:8000)",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Print full responses",
    )
    args = parser.parse_args()

    prompts = load_prompts()
    base = args.url.rstrip("/")

    print(f"Validating against {base}/v1/chat/completions ({len(prompts)} prompts)...")
    print()

    failed = 0
    for i, item in enumerate(prompts):
        prompt = item["prompt"]
        must = item.get("response_must_contain", [])
        must_not = item.get("response_must_not_contain", [])

        content, status = post_chat(base, prompt)

        if status != 200:
            print(f"  ✗ [{i+1}] \"{prompt[:50]}...\" — HTTP {status}")
            if args.verbose:
                print(f"      {content[:300]}...")
            failed += 1
            continue

        ok = True
        for s in must:
            if s not in content:
                ok = False
                break
        for s in must_not:
            if s in content:
                ok = False
                break

        if ok:
            print(f"  ✓ [{i+1}] \"{prompt[:50]}...\"")
        else:
            print(f"  ✗ [{i+1}] \"{prompt[:50]}...\"")
            if must:
                for s in must:
                    print(f"      must contain: {s!r} — {'OK' if s in content else 'MISSING'}")
            if must_not:
                for s in must_not:
                    print(f"      must not contain: {s!r} — {'OK' if s not in content else 'FOUND'}")
            if args.verbose:
                print(f"      Response preview: {content[:400]}...")
            failed += 1

    print()
    if failed == 0:
        print("All checks passed.")
        return 0
    print(f"{failed}/{len(prompts)} checks failed.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
