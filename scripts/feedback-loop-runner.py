#!/usr/bin/env python3
"""Feedback loop CLI helper for Admin closed-loop workflows."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def _base_url() -> str:
    return os.getenv("SYNESIS_ADMIN_API_URL", "http://localhost:8080/api/v1").rstrip("/")


def _headers() -> dict[str, str]:
    token = os.getenv("SYNESIS_ADMIN_BEARER_TOKEN", "").strip()
    out = {"Content-Type": "application/json"}
    if token:
        out["Authorization"] = f"Bearer {token}"
    return out


def _request(method: str, path: str, payload: dict | None = None) -> dict:
    url = f"{_base_url()}{path}"
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url=url, data=data, method=method, headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        msg = exc.read().decode("utf-8")
        raise RuntimeError(f"{method} {path} failed: {exc.code} {msg}") from exc
    return json.loads(body or "{}")


def cmd_collect(args: argparse.Namespace) -> None:
    out = _request(
        "POST",
        "/feedback-loop/runs",
        {
            "name": args.name,
            "description": args.description,
            "candidate_model": args.model,
            "execute_now": args.execute,
            "eval_suites": args.suite,
            "prompt_category": args.prompt_category,
        },
    )
    print(json.dumps(out, indent=2))


def cmd_pipeline(args: argparse.Namespace) -> None:
    out = _request(
        "POST",
        f"/feedback-loop/runs/{args.run_id}/pipeline",
        {
            "eval_suites": args.suite,
            "auto_label": not args.no_auto_label,
            "auto_critic_score": not args.no_auto_critic_score,
        },
    )
    print(json.dumps(out, indent=2))


def cmd_export(args: argparse.Namespace) -> None:
    q = urllib.parse.urlencode({"format": args.format, "dataset_type": args.dataset_type})
    out = _request("GET", f"/feedback-loop/runs/{args.run_id}/dataset?{q}")
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            if args.format == "jsonl":
                fh.write(str(out.get("records_jsonl", "")))
            else:
                json.dump(out, fh, indent=2)
        print(f"Wrote {args.out}")
        return
    print(json.dumps(out, indent=2))


def cmd_critic_score(args: argparse.Namespace) -> None:
    out = _request(
        "POST",
        f"/feedback-loop/runs/{args.run_id}/critic-score",
        {"overwrite": args.overwrite},
    )
    print(json.dumps(out, indent=2))


def cmd_run(args: argparse.Namespace) -> None:
    created = _request(
        "POST",
        "/feedback-loop/runs",
        {
            "name": args.name,
            "description": args.description,
            "candidate_model": args.model,
            "execute_now": True,
            "eval_suites": args.suite,
            "prompt_category": args.prompt_category,
        },
    )
    run_id = created.get("run_id")
    print(json.dumps(created, indent=2))
    if not run_id:
        return
    exported = _request(
        "GET",
        f"/feedback-loop/runs/{run_id}/dataset?format=jsonl&dataset_type={urllib.parse.quote(args.dataset_type)}",
    )
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(str(exported.get("records_jsonl", "")))
        print(f"Wrote {args.out}")


def main() -> int:
    p = argparse.ArgumentParser(description="Synesis feedback loop runner")
    sub = p.add_subparsers(dest="cmd", required=True)

    collect = sub.add_parser("collect", help="Create run (and optionally execute).")
    collect.add_argument("--name", required=True)
    collect.add_argument("--description", default="")
    collect.add_argument("--model", default="synesis-agent")
    collect.add_argument("--prompt-category", default="")
    collect.add_argument("--execute", action="store_true")
    collect.add_argument("--suite", action="append", default=[])
    collect.set_defaults(func=cmd_collect)

    pipeline = sub.add_parser("pipeline", help="Execute full pipeline for existing run.")
    pipeline.add_argument("--run-id", required=True)
    pipeline.add_argument("--suite", action="append", default=[])
    pipeline.add_argument("--no-auto-label", action="store_true")
    pipeline.add_argument("--no-auto-critic-score", action="store_true")
    pipeline.set_defaults(func=cmd_pipeline)

    export = sub.add_parser("export", help="Export run dataset.")
    export.add_argument("--run-id", required=True)
    export.add_argument("--format", choices=["json", "jsonl"], default="jsonl")
    export.add_argument("--dataset-type", choices=["trajectory", "dpo", "rlaif"], default="trajectory")
    export.add_argument("--out", default="")
    export.set_defaults(func=cmd_export)

    critic = sub.add_parser("critic-score", help="Apply critic scoring to run results.")
    critic.add_argument("--run-id", required=True)
    critic.add_argument("--overwrite", action="store_true")
    critic.set_defaults(func=cmd_critic_score)

    run = sub.add_parser("run", help="End-to-end create + execute + export.")
    run.add_argument("--name", required=True)
    run.add_argument("--description", default="")
    run.add_argument("--model", default="synesis-agent")
    run.add_argument("--prompt-category", default="")
    run.add_argument("--suite", action="append", default=[])
    run.add_argument("--dataset-type", choices=["trajectory", "dpo", "rlaif"], default="trajectory")
    run.add_argument("--out", default="")
    run.set_defaults(func=cmd_run)

    args = p.parse_args()
    try:
        args.func(args)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
