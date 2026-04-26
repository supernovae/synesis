#!/usr/bin/env python3
"""Prefix cache experiment for Synesis Yarn — MiniMax coder-core.

Sends identical payloads twice through Yarn to measure cached_tokens in
the response. Tests both a small stable prefix (~1k tokens) and a large
stable prefix (~8k tokens) to see if MiniMax caps prefix caching around
~3.1k or if a larger stable block actually extends the cache window.

Usage:
  export SYNESIS_YARN_URL=https://synesis-yarn.apps.openshiftdemo.dev
  export SYNESIS_TEST_TOKEN=<internal-service-token or PAT>
  python3 scripts/cache-prefix-experiment.py [--model synesis-core]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from typing import Any

try:
    import requests
except ImportError:
    print("Missing dependency: requests. Install with `pip install requests`.", file=sys.stderr)
    raise SystemExit(2)


SMALL_STABLE_PREFIX = """You are a senior software engineer. Follow these rules precisely:

1. Always write clean, idiomatic code.
2. Follow the principle of least surprise.
3. Use meaningful variable names.
4. Keep functions small and focused.
5. Write tests for all new functionality.
6. Handle errors explicitly, never silently swallow exceptions.
7. Prefer composition over inheritance.
8. Document public APIs with clear docstrings.
9. Use type annotations where the language supports them.
10. Keep dependencies minimal and well-justified.
"""

LARGE_STABLE_PREFIX = """You are a senior software engineer working on a complex distributed system. Follow these comprehensive engineering principles and guidelines precisely:

## Architecture Principles

1. **Separation of Concerns**: Each module, class, and function should have a single, well-defined responsibility. Cross-cutting concerns (logging, auth, metrics) should be handled via middleware or aspect-oriented patterns, not scattered across business logic.

2. **Dependency Inversion**: High-level modules should not depend on low-level modules. Both should depend on abstractions. Abstractions should not depend on details; details should depend on abstractions.

3. **Interface Segregation**: No client should be forced to depend on methods it does not use. Prefer many small, focused interfaces over a few large, general-purpose ones.

4. **Open/Closed Principle**: Software entities should be open for extension but closed for modification. Use strategy patterns, plugin architectures, and configuration-driven behavior.

5. **Liskov Substitution**: Objects of a superclass should be replaceable with objects of a subclass without affecting program correctness. Subtypes must honor the contracts of their supertypes.

## Code Quality Standards

6. **Naming Conventions**: Use descriptive, intention-revealing names. Variable names should explain what the variable holds, function names should describe what they do, class names should describe what they represent. Avoid abbreviations unless universally understood (e.g., `url`, `id`, `db`).

7. **Function Design**: Functions should do one thing, do it well, and do it only. Prefer pure functions where possible. Limit side effects and document them clearly. Functions should have at most 3-4 parameters; use parameter objects for more.

8. **Error Handling**: Handle errors explicitly. Never silently swallow exceptions. Use typed errors or error codes. Distinguish between recoverable and unrecoverable errors. Log sufficient context for debugging. Provide actionable error messages to users.

9. **Testing Philosophy**: Write tests before or alongside code, not as an afterthought. Unit tests for logic, integration tests for boundaries, end-to-end tests for critical paths. Tests should be fast, deterministic, and independent. Aim for >80% branch coverage on critical paths.

10. **Documentation**: Document the "why", not the "what". Code should be self-documenting for the "what". Public APIs need clear docstrings with parameter descriptions, return types, exceptions, and usage examples. Architecture decisions should be recorded in ADRs.

## Distributed Systems Patterns

11. **Idempotency**: All write operations must be idempotent. Use idempotency keys for external calls. Design state machines so replaying events produces the same final state.

12. **Circuit Breakers**: Wrap external service calls with circuit breakers. Define clear thresholds for open/half-open/closed states. Provide fallback behavior when circuits are open.

13. **Retry Policies**: Use exponential backoff with jitter for retries. Set maximum retry counts. Distinguish between transient and permanent failures. Never retry non-idempotent operations without explicit safeguards.

14. **Eventual Consistency**: Design for eventual consistency where strong consistency is not required. Use saga patterns for distributed transactions. Implement compensating transactions for rollback. Monitor convergence times.

15. **Observability**: Instrument all services with structured logging, distributed tracing, and metrics. Use correlation IDs across service boundaries. Alert on SLO violations, not just errors. Maintain runbooks for common failure modes.

## Security Requirements

16. **Input Validation**: Validate all inputs at system boundaries. Use allowlists over denylists. Sanitize data for the specific output context (HTML, SQL, shell, etc.). Never trust client-side validation alone.

17. **Authentication & Authorization**: Use standard protocols (OAuth2, OIDC). Implement principle of least privilege. Rotate credentials regularly. Use short-lived tokens. Separate authentication from authorization.

18. **Data Protection**: Encrypt data at rest and in transit. Use parameterized queries to prevent injection. Minimize data collection. Implement data retention policies. Log access to sensitive data.

19. **Supply Chain Security**: Pin dependency versions. Verify checksums/signatures. Scan for known vulnerabilities. Minimize the dependency tree. Review transitive dependencies.

20. **Secrets Management**: Never hardcode secrets. Use a secrets manager (Vault, AWS Secrets Manager). Inject secrets via environment at runtime. Rotate secrets on schedule and after incidents.

## Performance Guidelines

21. **Caching Strategy**: Cache at the right layer (CDN, application, database). Set appropriate TTLs. Implement cache invalidation strategies. Monitor cache hit rates. Use write-through or write-behind patterns based on consistency requirements.

22. **Database Optimization**: Design schemas for query patterns. Index strategically. Use connection pooling. Implement read replicas for read-heavy workloads. Monitor slow queries. Partition large tables.

23. **Resource Management**: Close connections, file handles, and other resources deterministically. Use connection pools. Set timeouts on all external calls. Implement backpressure mechanisms. Monitor resource utilization.

24. **Concurrency**: Prefer message passing over shared mutable state. Use appropriate synchronization primitives. Design for lock-free algorithms where possible. Test for race conditions. Document thread-safety guarantees.

25. **Capacity Planning**: Load test before major releases. Establish performance baselines. Set up autoscaling with appropriate thresholds. Plan for 3x headroom on peak load. Monitor and alert on capacity utilization.

## Operational Excellence

26. **Deployment**: Use immutable infrastructure. Implement blue-green or canary deployments. Automate rollbacks. Test deployment procedures. Maintain environment parity between staging and production.

27. **Monitoring**: Define SLIs, SLOs, and SLAs for each service. Implement health checks. Monitor business metrics alongside technical metrics. Set up dashboards for each team's services. Practice incident response.

28. **Configuration**: Externalize configuration from code. Use feature flags for gradual rollouts. Validate configuration at startup. Document all configuration parameters. Implement configuration drift detection.

29. **Logging**: Use structured logging (JSON). Include correlation IDs. Log at appropriate levels. Implement log aggregation. Set retention policies. Never log sensitive data (PII, credentials, tokens).

30. **Disaster Recovery**: Define RPO and RTO for each service. Implement automated backups. Test restore procedures regularly. Document recovery runbooks. Practice chaos engineering.

## Code Review Standards

31. **Review Criteria**: Every change must be reviewed by at least one domain expert. Check for correctness, security, performance, and maintainability. Verify tests cover the change. Ensure documentation is updated. Look for unintended side effects.

32. **Change Management**: Keep changes small and focused. One logical change per PR. Include context and motivation in PR descriptions. Link to relevant issues or design docs. Tag breaking changes clearly.

## API Design

33. **REST Conventions**: Use proper HTTP methods and status codes. Version APIs. Paginate list endpoints. Use consistent naming (kebab-case URLs, camelCase JSON). Document with OpenAPI/Swagger.

34. **Contract Testing**: Define API contracts early. Use consumer-driven contract testing. Version schemas. Maintain backward compatibility. Deprecate gracefully with migration guides.

35. **Rate Limiting**: Implement rate limiting on all public endpoints. Use token bucket or sliding window algorithms. Return standard rate limit headers. Provide different limits per tier. Monitor and alert on rate limit violations.
"""

DYNAMIC_USER_QUERY = "Explain the trade-offs between using Redis vs Memcached for session caching in a horizontally-scaled web application. Keep it concise."


def build_payload(
    *,
    model: str,
    system_prefix: str,
    conversation_id: str,
    include_tools: bool = True,
) -> dict[str, Any]:
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prefix},
        {"role": "user", "content": DYNAMIC_USER_QUERY},
    ]

    tools = []
    if include_tools:
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "search_docs",
                    "description": "Search internal documentation for relevant information.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "The search query"},
                            "max_results": {"type": "integer", "description": "Maximum results to return", "default": 5},
                        },
                        "required": ["query"],
                    },
                },
            },
        ]

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": 200,
        "stream": False,
        "temperature": 0.1,
        "metadata": {
            "synesis_conversation_id": conversation_id,
            "synesis_project_root": "/tmp/cache-experiment",
            "synesis_shell_cwd": "/tmp/cache-experiment",
        },
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "none"

    return payload


def extract_cache_info(response_json: dict[str, Any]) -> dict[str, Any]:
    usage = response_json.get("usage", {})
    details = usage.get("prompt_tokens_details", {})
    return {
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
        "cached_tokens": details.get("cached_tokens", usage.get("cached_prompt_tokens", 0)),
        "cache_creation_tokens": details.get("cache_creation_input_tokens", usage.get("cache_creation_tokens", 0)),
        "cache_hit_pct": 0.0,
    }


def send_request(
    base_url: str,
    token: str,
    payload: dict[str, Any],
    conversation_id: str,
    label: str,
) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "x-synesis-client": "cache-prefix-experiment",
        "x-synesis-conversation-id": conversation_id,
    }

    print(f"\n{'='*60}")
    print(f"  {label}")
    print(f"{'='*60}")
    sys_content = payload["messages"][0]["content"]
    print(f"  System prefix length: {len(sys_content)} chars")
    print(f"  Model: {payload['model']}")
    print(f"  Conversation ID: {conversation_id}")

    start = time.time()
    resp = requests.post(url, headers=headers, json=payload, timeout=120)
    elapsed = time.time() - start

    print(f"  HTTP status: {resp.status_code}")
    print(f"  Latency: {elapsed:.2f}s")

    if resp.status_code != 200:
        print(f"  ERROR: {resp.text[:500]}")
        return {"error": resp.text[:500], "status": resp.status_code}

    data = resp.json()
    cache_info = extract_cache_info(data)

    prompt_tokens = cache_info["prompt_tokens"]
    cached_tokens = cache_info["cached_tokens"]
    if prompt_tokens > 0:
        cache_info["cache_hit_pct"] = round(100.0 * cached_tokens / prompt_tokens, 1)

    print(f"  Prompt tokens:  {prompt_tokens}")
    print(f"  Cached tokens:  {cached_tokens}")
    print(f"  Cache creation: {cache_info['cache_creation_tokens']}")
    print(f"  Cache hit %:    {cache_info['cache_hit_pct']}%")
    print(f"  Completion:     {cache_info['completion_tokens']}")

    choices = data.get("choices", [])
    if choices:
        content = choices[0].get("message", {}).get("content", "")
        print(f"  Response (first 120): {content[:120]}")

    # Also dump raw usage for inspection
    print(f"  Raw usage: {json.dumps(data.get('usage', {}), indent=2)}")

    return cache_info


def run_experiment(
    base_url: str,
    token: str,
    model: str,
    pause_sec: float = 2.0,
) -> None:
    print("\n" + "#" * 70)
    print("#  PREFIX CACHE EXPERIMENT")
    print(f"#  Model: {model}")
    print(f"#  Endpoint: {base_url}")
    print(f"#  Pause between requests: {pause_sec}s")
    print("#" * 70)

    results: dict[str, list[dict[str, Any]]] = {
        "small_prefix": [],
        "large_prefix": [],
    }

    # --- SMALL PREFIX: Two identical requests ---
    conv_small = f"cache-exp-small-{uuid.uuid4().hex[:8]}"
    for i in range(2):
        payload = build_payload(
            model=model,
            system_prefix=SMALL_STABLE_PREFIX,
            conversation_id=conv_small,
        )
        info = send_request(
            base_url, token, payload, conv_small,
            f"SMALL PREFIX — Request {i+1}/2 (conv={conv_small[:20]}...)",
        )
        results["small_prefix"].append(info)
        if i == 0:
            print(f"\n  [Pausing {pause_sec}s to let cache populate...]")
            time.sleep(pause_sec)

    # --- LARGE PREFIX: Two identical requests ---
    conv_large = f"cache-exp-large-{uuid.uuid4().hex[:8]}"
    for i in range(2):
        payload = build_payload(
            model=model,
            system_prefix=LARGE_STABLE_PREFIX,
            conversation_id=conv_large,
        )
        info = send_request(
            base_url, token, payload, conv_large,
            f"LARGE PREFIX — Request {i+1}/2 (conv={conv_large[:20]}...)",
        )
        results["large_prefix"].append(info)
        if i == 0:
            print(f"\n  [Pausing {pause_sec}s to let cache populate...]")
            time.sleep(pause_sec)

    # --- LARGE PREFIX: Third request with SAME conv to see if cache persists ---
    payload = build_payload(
        model=model,
        system_prefix=LARGE_STABLE_PREFIX,
        conversation_id=conv_large,
    )
    info = send_request(
        base_url, token, payload, conv_large,
        f"LARGE PREFIX — Request 3/3 (persistence check, conv={conv_large[:20]}...)",
    )
    results["large_prefix"].append(info)

    # --- SUMMARY ---
    print("\n\n" + "=" * 70)
    print("  SUMMARY")
    print("=" * 70)

    for label, data_list in results.items():
        print(f"\n  {label.upper()}:")
        for i, info in enumerate(data_list):
            if "error" in info:
                print(f"    Request {i+1}: ERROR - {info['error'][:80]}")
            else:
                print(
                    f"    Request {i+1}: prompt={info['prompt_tokens']}, "
                    f"cached={info['cached_tokens']}, "
                    f"hit={info['cache_hit_pct']}%, "
                    f"creation={info['cache_creation_tokens']}"
                )

    # Analysis
    print(f"\n  ANALYSIS:")
    s = results["small_prefix"]
    l = results["large_prefix"]

    if len(s) >= 2 and "error" not in s[1] and "error" not in s[0]:
        s_delta = s[1]["cached_tokens"] - s[0]["cached_tokens"]
        print(f"    Small prefix cache delta (req2 - req1): {s_delta} tokens")
        print(f"    Small prefix req2 cached_tokens: {s[1]['cached_tokens']}")

    if len(l) >= 2 and "error" not in l[1] and "error" not in l[0]:
        l_delta = l[1]["cached_tokens"] - l[0]["cached_tokens"]
        print(f"    Large prefix cache delta (req2 - req1): {l_delta} tokens")
        print(f"    Large prefix req2 cached_tokens: {l[1]['cached_tokens']}")

    if len(l) >= 3 and "error" not in l[2]:
        print(f"    Large prefix req3 cached_tokens: {l[2]['cached_tokens']} (persistence)")

    if (
        len(s) >= 2 and "error" not in s[1]
        and len(l) >= 2 and "error" not in l[1]
    ):
        s_cache = s[1]["cached_tokens"]
        l_cache = l[1]["cached_tokens"]
        if s_cache > 0 and l_cache > 0:
            ratio = l_cache / s_cache
            print(f"\n    Large/Small cache ratio: {ratio:.2f}x")
            if ratio > 1.5:
                print("    --> LARGER PREFIX EXTENDS CACHE: MiniMax does scale beyond ~3.1k")
            elif 0.8 < ratio < 1.2:
                print("    --> CACHE APPEARS CAPPED: larger prefix did NOT increase cached tokens")
                print(f"        (both ~{s_cache} tokens, possible ~3.1k cap)")
            else:
                print(f"    --> Inconclusive ratio. Manual inspection recommended.")
        elif l_cache == 0 and s_cache == 0:
            print("\n    --> NO CACHING OBSERVED on either prefix size")
            print("        Provider may not report cached_tokens or caching is disabled")
        else:
            print(f"\n    --> Asymmetric: small={s_cache}, large={l_cache}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prefix cache experiment for Synesis Yarn",
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("SYNESIS_YARN_URL", "https://synesis-yarn.apps.openshiftdemo.dev"),
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("SYNESIS_TEST_TOKEN", ""),
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("SYNESIS_VERIFY_MODEL", "synesis-core"),
    )
    parser.add_argument(
        "--pause",
        type=float,
        default=2.0,
        help="Seconds to wait between paired requests",
    )
    args = parser.parse_args()

    if not args.token:
        print("Missing --token (or SYNESIS_TEST_TOKEN env). Trying to read from oc...", file=sys.stderr)
        try:
            import subprocess
            result = subprocess.run(
                ["oc", "get", "secret", "synesis-internal-service-auth", "-n", "synesis-yarn",
                 "-o", "jsonpath={.data.token}"],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0 and result.stdout.strip():
                import base64
                args.token = base64.b64decode(result.stdout.strip()).decode()
                print(f"  Got token from oc: {args.token[:20]}...", file=sys.stderr)
            else:
                print("  Failed to get token from oc. Provide --token or SYNESIS_TEST_TOKEN.", file=sys.stderr)
                return 2
        except Exception as e:
            print(f"  oc fallback failed: {e}", file=sys.stderr)
            return 2

    run_experiment(args.base_url, args.token, args.model, args.pause)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
