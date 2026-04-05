from __future__ import annotations

import argparse
import os
from pathlib import Path

from .analysis import build_kpi_snapshot, build_session_inspect
from .canary_pack import ab_scaffold_payload, checklist_payload
from .client import AdminApiClient
from .render import as_json, generic_markdown, kpi_as_markdown, session_as_markdown

DEFAULT_ADMIN_URL = "http://127.0.0.1:8080"
DEFAULT_CANARY_PACK = "docs/clients/CANARY_PROMPT_PACK.md"


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--admin-base-url",
        default=os.environ.get("SYNESIS_ADMIN_BASE_URL", DEFAULT_ADMIN_URL),
        help="Admin API base URL (default: %(default)s, env SYNESIS_ADMIN_BASE_URL)",
    )
    p.add_argument(
        "--token",
        default=os.environ.get("SYNESIS_ADMIN_TOKEN", ""),
        help="Bearer token for Admin API (env SYNESIS_ADMIN_TOKEN)",
    )
    p.add_argument("--timeout-sec", type=float, default=20.0, help="HTTP timeout seconds")
    p.add_argument("--format", choices=["json", "markdown"], default="json")
    p.add_argument("-o", "--output", default="", help="Write output to file path")


def _write_or_print(text: str, output_path: str) -> None:
    if output_path:
        Path(output_path).write_text(text + ("" if text.endswith("\n") else "\n"), encoding="utf-8")
    else:
        print(text)


def _client(args: argparse.Namespace) -> AdminApiClient:
    token = args.token.strip() or None
    return AdminApiClient(base_url=args.admin_base_url, token=token, timeout_sec=args.timeout_sec)


def cmd_kpi_snapshot(args: argparse.Namespace) -> int:
    client = _client(args)
    intelligence = client.get_json("/api/v1/yarn/intelligence", {"since_hours": args.since_hours})
    performance = client.get_json(
        "/api/v1/yarn/performance",
        {"since_hours": args.since_hours, "bucket_minutes": args.bucket_minutes},
    )
    usage_summary = client.get_json("/api/v1/usage/summary", {"since_hours": args.since_hours})
    payload = build_kpi_snapshot(
        intelligence=intelligence,
        performance=performance if isinstance(performance, list) else [],
        usage_summary=usage_summary if isinstance(usage_summary, dict) else {},
        since_hours=args.since_hours,
        bucket_minutes=args.bucket_minutes,
    )
    text = as_json(payload) if args.format == "json" else kpi_as_markdown(payload)
    _write_or_print(text, args.output)
    return 0


def cmd_session_inspect(args: argparse.Namespace) -> int:
    client = _client(args)
    detail = client.get_json(f"/api/v1/yarn/sessions/{args.session_key}")
    payload = build_session_inspect(detail if isinstance(detail, dict) else {})
    text = as_json(payload) if args.format == "json" else session_as_markdown(payload)
    _write_or_print(text, args.output)
    return 0


def cmd_canary_checklist(args: argparse.Namespace) -> int:
    payload = checklist_payload(Path(args.pack_path))
    text = as_json(payload) if args.format == "json" else generic_markdown("Canary Checklist", payload)
    _write_or_print(text, args.output)
    return 0


def cmd_ab_scaffold(args: argparse.Namespace) -> int:
    payload = ab_scaffold_payload(
        pack_path=Path(args.pack_path),
        run_a_name=args.run_a_name,
        run_b_name=args.run_b_name,
        model_id=args.model_id,
    )
    text = as_json(payload) if args.format == "json" else generic_markdown("A/B Scaffold", payload)
    _write_or_print(text, args.output)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="synesis-power",
        description="Power CLI for Synesis Admin KPI/session/canary workflows",
    )
    root = parser.add_subparsers(dest="group", required=True)

    kpi = root.add_parser("kpi", help="KPI snapshot commands")
    kpi_sub = kpi.add_subparsers(dest="kpi_cmd", required=True)
    kpi_snapshot = kpi_sub.add_parser("snapshot", help="Fetch KPI snapshot from Admin APIs")
    _add_common(kpi_snapshot)
    kpi_snapshot.add_argument("--since-hours", type=int, default=24)
    kpi_snapshot.add_argument("--bucket-minutes", type=int, default=15)
    kpi_snapshot.set_defaults(func=cmd_kpi_snapshot)

    session = root.add_parser("session", help="Session inspection commands")
    session_sub = session.add_subparsers(dest="session_cmd", required=True)
    session_inspect = session_sub.add_parser("inspect", help="Inspect a Yarn session detail")
    _add_common(session_inspect)
    session_inspect.add_argument("--session-key", required=True)
    session_inspect.set_defaults(func=cmd_session_inspect)

    canary = root.add_parser("canary", help="Canary prompt-pack helpers")
    canary_sub = canary.add_subparsers(dest="canary_cmd", required=True)
    canary_checklist = canary_sub.add_parser("checklist", help="Generate canary checklist payload")
    canary_checklist.add_argument("--pack-path", default=DEFAULT_CANARY_PACK)
    canary_checklist.add_argument("--format", choices=["json", "markdown"], default="json")
    canary_checklist.add_argument("-o", "--output", default="")
    canary_checklist.set_defaults(func=cmd_canary_checklist)

    ab = root.add_parser("ab", help="A/B run helpers")
    ab_sub = ab.add_subparsers(dest="ab_cmd", required=True)
    ab_scaffold = ab_sub.add_parser("scaffold", help="Generate A/B run manifests")
    ab_scaffold.add_argument("--pack-path", default=DEFAULT_CANARY_PACK)
    ab_scaffold.add_argument("--run-a-name", default="A")
    ab_scaffold.add_argument("--run-b-name", default="B")
    ab_scaffold.add_argument("--model-id", default="same-base-model")
    ab_scaffold.add_argument("--format", choices=["json", "markdown"], default="json")
    ab_scaffold.add_argument("-o", "--output", default="")
    ab_scaffold.set_defaults(func=cmd_ab_scaffold)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    fn = getattr(args, "func", None)
    if fn is None:
        parser.print_help()
        return 2
    return int(fn(args))
