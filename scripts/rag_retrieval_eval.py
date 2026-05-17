#!/usr/bin/env python3
"""Run retrieval-focused evals against planner POST /v1/knowledge/search.

Auth (important):
  This route is wired for the *shared internal service token* (same Bearer value MCP
  uses to call the planner — see base/synesis-mcp knowledge-search handler), not a user PAT.

  Admin PATs (syn-...) work on user-facing planner routes (e.g. chat completions) but
  will get 401 on /v1/knowledge/search if you pass them here. Use the token from
  secret synesis-internal-service-auth (key token), or SYNESIS_INTERNAL_SERVICE_TOKEN /
  SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN in your environment.

Usage:
  # 1) Port-forward planner
  # oc port-forward svc/synesis-planner-ts 8080:8080 -n synesis-planner
  #
  # 2) Run eval suite (use internal token, not PAT)
  # export SYNESIS_INTERNAL_SERVICE_TOKEN=...   # or SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN
  # python scripts/rag_retrieval_eval.py \
  #   --url http://localhost:8080 \
  #   --suite tests/prompts/go_retrieval_eval.yaml \
  #   --domain go --top-k 8
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx


def _resolve_internal_token(cli_token: str) -> str:
    """Planner knowledge/search expects the internal service token; support common env names."""
    t = cli_token.strip()
    if t:
        return t
    for key in (
        "SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN",
        "SYNESIS_INTERNAL_SERVICE_TOKEN",
    ):
        v = os.environ.get(key, "").strip()
        if v:
            return v
    return ""


def _looks_like_pat(token: str) -> bool:
    return token.strip().startswith("syn-")


def _load_yaml(path: Path) -> dict[str, Any]:
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - runtime dependency message
        raise RuntimeError("PyYAML is required (pip install pyyaml)") from exc
    data = yaml.safe_load(path.read_text()) or {}
    if not isinstance(data, dict):
        raise ValueError(f"Expected mapping in suite file: {path}")
    return data


def _contains_any(haystacks: list[str], needles: list[str]) -> bool:
    if not needles:
        return True
    merged = "\n".join(haystacks).lower()
    return any(n.lower() in merged for n in needles)


def _post_knowledge_search(
    *,
    base_url: str,
    token: str,
    query: str,
    top_k: int,
    domain: str | None,
    language: str | None,
    caller_org_id: str | None,
    caller_tenant_ids: list[str] | None,
    caller_acl_groups: list[str] | None,
    caller_user_id: str | None,
) -> tuple[int, dict[str, Any], float]:
    t0 = time.time()
    payload: dict[str, Any] = {"query": query, "top_k": top_k}
    if domain:
        payload["domain"] = domain
    if language:
        payload["language"] = language
    if caller_org_id:
        payload["caller_org_id"] = caller_org_id
    if caller_tenant_ids:
        payload["caller_tenant_ids"] = caller_tenant_ids
    if caller_acl_groups:
        payload["caller_acl_groups"] = caller_acl_groups
    if caller_user_id:
        payload["caller_user_id"] = caller_user_id
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    with httpx.Client(timeout=45.0) as client:
        resp = client.post(f"{base_url.rstrip('/')}/v1/knowledge/search", json=payload, headers=headers)
    elapsed_ms = (time.time() - t0) * 1000.0
    body: dict[str, Any]
    try:
        body = resp.json()
    except Exception:
        body = {"raw": resp.text}
    return resp.status_code, body, elapsed_ms


def main() -> int:
    parser = argparse.ArgumentParser(description="Run planner retrieval eval suite")
    parser.add_argument("--url", default="http://localhost:8080", help="Planner base URL")
    parser.add_argument("--suite", default="tests/prompts/go_retrieval_eval.yaml", help="YAML eval suite file")
    parser.add_argument(
        "--token",
        default="",
        help="Internal service Bearer token for planner (not a user PAT). "
        "If omitted, uses SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN or SYNESIS_INTERNAL_SERVICE_TOKEN.",
    )
    parser.add_argument("--top-k", type=int, default=8, help="Knowledge search top_k")
    parser.add_argument("--domain", default="go", help="Default domain filter")
    parser.add_argument(
        "--disable-domain-filter", action="store_true", help="Disable domain filter even when suite cases set domain"
    )
    parser.add_argument("--language", default="", help="Default language filter")
    parser.add_argument("--caller-org-id", default="", help="Optional caller org_id for scoped retrieval")
    parser.add_argument("--caller-tenant-ids", default="", help="Optional comma-separated caller tenant_ids")
    parser.add_argument("--caller-acl-groups", default="", help="Optional comma-separated caller acl groups")
    parser.add_argument("--caller-user-id", default="", help="Optional caller user_id for scoped retrieval")
    parser.add_argument("--save-json", default="", help="Optional path to save full JSON results")
    parser.add_argument("--verbose", action="store_true", help="Print top source names")
    args = parser.parse_args()

    token = _resolve_internal_token(args.token)
    if not token:
        print(
            "Missing internal service token. Pass --token or set "
            "SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN or SYNESIS_INTERNAL_SERVICE_TOKEN "
            "(same value as secret synesis-internal-service-auth / MCP→planner). "
            "User PATs (syn-...) are not accepted on /v1/knowledge/search.",
            file=sys.stderr,
        )
        return 2

    suite_path = Path(args.suite)
    if not suite_path.exists():
        print(f"Suite file not found: {suite_path}", file=sys.stderr)
        return 2

    suite = _load_yaml(suite_path)
    cases = suite.get("cases", [])
    if not isinstance(cases, list) or not cases:
        print("Suite has no cases.", file=sys.stderr)
        return 2

    results: list[dict[str, Any]] = []
    passed = 0

    print(f"Running {len(cases)} retrieval eval cases against {args.url.rstrip('/')}/v1/knowledge/search")
    print()

    caller_org_id = str(args.caller_org_id or "").strip() or None
    caller_tenant_ids = [x.strip() for x in str(args.caller_tenant_ids or "").split(",") if x.strip()] or None
    caller_acl_groups = [x.strip() for x in str(args.caller_acl_groups or "").split(",") if x.strip()] or None
    caller_user_id = str(args.caller_user_id or "").strip() or None

    for idx, case in enumerate(cases, start=1):
        if not isinstance(case, dict):
            continue
        name = str(case.get("name", f"case-{idx}"))
        query = str(case.get("query", "")).strip()
        if not query:
            continue
        expected_sources = [str(x) for x in (case.get("expected_sources_any") or [])]
        expected_text = [str(x) for x in (case.get("expected_text_any") or [])]
        required_min_hits = int(case.get("min_hits", 1))
        if args.disable_domain_filter:
            domain = None
        else:
            domain = str(case.get("domain", args.domain or "")).strip() or None
        language = str(case.get("language", args.language or "")).strip() or None

        status, body, elapsed_ms = _post_knowledge_search(
            base_url=args.url,
            token=token,
            query=query,
            top_k=max(1, args.top_k),
            domain=domain,
            language=language,
            caller_org_id=caller_org_id,
            caller_tenant_ids=caller_tenant_ids,
            caller_acl_groups=caller_acl_groups,
            caller_user_id=caller_user_id,
        )

        case_result: dict[str, Any] = {
            "name": name,
            "query": query,
            "status": status,
            "elapsed_ms": round(elapsed_ms, 1),
            "pass": False,
            "reason": "",
        }

        if status != 200:
            case_result["reason"] = f"http_{status}"
            print(f"✗ [{idx}] {name} (HTTP {status})")
            if status == 401 and _looks_like_pat(token):
                print(
                    "  Hint: /v1/knowledge/search expects the internal service token, not a PAT (syn-...). "
                    "Use the same Bearer value as synesis-internal-service-auth (see script docstring).",
                    file=sys.stderr,
                )
            results.append(case_result)
            continue

        rows = body.get("results", [])
        if not isinstance(rows, list):
            rows = []
        case_result["hits"] = len(rows)
        source_names = [str(r.get("document_name", "")) for r in rows[: max(1, args.top_k)] if isinstance(r, dict)]
        source_urls = [str(r.get("source_url", "")) for r in rows[: max(1, args.top_k)] if isinstance(r, dict)]
        texts = [str(r.get("text", "")) for r in rows[: max(1, args.top_k)] if isinstance(r, dict)]

        got_min_hits = len(rows) >= required_min_hits
        source_ok = _contains_any(source_names + source_urls, expected_sources)
        text_ok = _contains_any(texts, expected_text)
        is_pass = bool(got_min_hits and source_ok and text_ok)

        case_result["pass"] = is_pass
        case_result["source_names"] = source_names
        case_result["source_urls"] = source_urls
        case_result["checks"] = {
            "min_hits": got_min_hits,
            "source_match": source_ok,
            "text_match": text_ok,
        }

        if is_pass:
            passed += 1
            print(f"✓ [{idx}] {name} ({len(rows)} hits, {elapsed_ms:.0f}ms)")
        else:
            miss = []
            if not got_min_hits:
                miss.append(f"min_hits<{required_min_hits}")
            if not source_ok:
                miss.append("source_miss")
            if not text_ok:
                miss.append("text_miss")
            case_result["reason"] = ",".join(miss)
            print(f"✗ [{idx}] {name} ({len(rows)} hits, {elapsed_ms:.0f}ms) -> {case_result['reason']}")
            if args.verbose:
                for sn in source_names[:5]:
                    print(f"    - {sn}")

        results.append(case_result)

    total = len(results)
    failed = total - passed
    pass_rate = (passed / total * 100.0) if total else 0.0
    print()
    print(f"Result: {passed}/{total} passed ({pass_rate:.1f}%), {failed} failed")

    output = {
        "suite": str(suite.get("name", suite_path.stem)),
        "total": total,
        "passed": passed,
        "failed": failed,
        "pass_rate": round(pass_rate, 2),
        "results": results,
    }
    if args.save_json.strip():
        out_path = Path(args.save_json)
        out_path.write_text(json.dumps(output, indent=2))
        print(f"Saved results: {out_path}")

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
