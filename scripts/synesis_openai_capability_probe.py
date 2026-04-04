#!/usr/bin/env python3
# ruff: noqa: S310 — deliberate urllib calls to operator-supplied HTTP(S) URLs.
"""Probe Synesis planner (and optionally Yarn) for OpenAI-compatible surface area.

This is a **gap-awareness** tool, not a CI gate. It checks documented shapes
(``/v1/models`` per OpenAI Model object; non-stream chat ``usage`` keys).

Environment:
  SYNESIS_PROBE_PLANNER_URL   Base URL (default http://127.0.0.1:8000)
  SYNESIS_PROBE_YARN_URL      Optional second base (e.g. Yarn OpenAI port)
  SYNESIS_TEST_PAT_TOKEN      Preferred PAT for /v1 (CI; user-space)
  SYNESIS_PROBE_TOKEN         Fallback Bearer (PAT); chat checks skip if unset

Exit code: 0 unless ``--strict`` and any check fails.

Open Harness (https://github.com/jeffrschneider/OpenHarness) conformance tests
target **Open Harness MAPI adapters** (Claude Code, Goose, …), not arbitrary
OpenAI ``/v1`` URLs — use this script for planner/Yarn HTTP checks.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any


def _openai_base_url(url: str) -> str:
    """Normalize base URL so we append ``/v1/...`` once (strip trailing ``/v1``)."""
    u = url.strip().rstrip("/")
    if u.endswith("/v1"):
        u = u[:-3].rstrip("/")
    return u


def _http(method: str, url: str, headers: dict[str, str], data: bytes | None = None, timeout: float = 90) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except urllib.error.URLError as e:
        return 0, str(e).encode()


def _check_models(base: str, token: str | None, label: str) -> dict[str, Any]:
    h: dict[str, str] = {}
    if token:
        h["Authorization"] = f"Bearer {token}"
    code, raw = _http("GET", f"{_openai_base_url(base)}/v1/models", h)
    out: dict[str, Any] = {"service": label, "check": "GET /v1/models", "http_status": code, "ok": False, "notes": []}
    if code != 200:
        out["notes"].append(raw.decode(errors="replace")[:800])
        return out
    try:
        body = json.loads(raw.decode())
    except json.JSONDecodeError as e:
        out["notes"].append(f"invalid json: {e}")
        return out
    if body.get("object") != "list" or not isinstance(body.get("data"), list):
        out["notes"].append("expected object=list and data array")
        return out
    for m in body["data"]:
        for k in ("id", "object", "created", "owned_by"):
            if k not in m:
                out["notes"].append(f"model entry missing required key {k!r} (OpenAI Model object)")
                return out
        if m.get("object") != "model":
            out["notes"].append(f"model {m.get('id')!r}: object should be 'model'")
            return out
        if not isinstance(m.get("created"), int):
            out["notes"].append(f"model {m.get('id')!r}: created must be int (unix seconds)")
            return out
    out["ok"] = True
    out["model_ids"] = [m.get("id") for m in body["data"]]
    return out


def _check_chat_nonstream(base: str, token: str, model: str, label: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "service": label,
        "check": "POST /v1/chat/completions (non-stream)",
        "ok": False,
        "notes": [],
    }
    body = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with exactly: ok"}],
        "max_tokens": 16,
        "stream": False,
    }
    payload = json.dumps(body).encode()
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
    code, raw = _http("POST", f"{_openai_base_url(base)}/v1/chat/completions", headers, data=payload)
    out["http_status"] = code
    if code != 200:
        out["notes"].append(raw.decode(errors="replace")[:1200])
        return out
    try:
        data = json.loads(raw.decode())
    except json.JSONDecodeError as e:
        out["notes"].append(f"invalid json: {e}")
        return out
    if data.get("object") != "chat.completion":
        out["notes"].append("expected object=chat.completion")
        return out
    usage = data.get("usage") or {}
    for k in ("prompt_tokens", "completion_tokens", "total_tokens"):
        if k not in usage:
            out["notes"].append(f"usage missing {k}")
            return out
    out["ok"] = True
    return out


def main() -> int:
    p = argparse.ArgumentParser(description="OpenAI-compat probe for Synesis services")
    p.add_argument(
        "--strict",
        action="store_true",
        help="Exit 1 if any check fails (default: always exit 0 for reporting)",
    )
    p.add_argument(
        "--planner-url",
        default=os.environ.get("SYNESIS_PROBE_PLANNER_URL", "http://127.0.0.1:8000"),
    )
    p.add_argument("--yarn-url", default=os.environ.get("SYNESIS_PROBE_YARN_URL", "").strip())
    p.add_argument(
        "--token",
        default=(
            os.environ.get("SYNESIS_TEST_PAT_TOKEN", "").strip()
            or os.environ.get("SYNESIS_PROBE_TOKEN", "").strip()
        ),
    )
    p.add_argument("--planner-model", default="Synesis")
    p.add_argument("--yarn-model", default="synesis-yarn")
    p.add_argument("-o", "--output-json", help="Write full report JSON to this path")
    args = p.parse_args()

    report: dict[str, Any] = {"checks": []}
    token = args.token or None

    pu = args.planner_url.strip()
    if pu:
        m = _check_models(pu, token, "planner")
        report["checks"].append(m)
        if token:
            report["checks"].append(_check_chat_nonstream(pu, token, args.planner_model, "planner"))

    yu = args.yarn_url.strip()
    if yu:
        m = _check_models(yu, token, "yarn")
        report["checks"].append(m)
        if token:
            report["checks"].append(_check_chat_nonstream(yu, token, args.yarn_model, "yarn"))

    failed = sum(1 for c in report["checks"] if not c.get("ok"))
    report["summary"] = {"total": len(report["checks"]), "failed": failed}

    text = json.dumps(report, indent=2)
    print(text)
    if args.output_json:
        with open(args.output_json, "w", encoding="utf-8") as f:
            f.write(text)

    if args.strict and failed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
