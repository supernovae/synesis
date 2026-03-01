#!/usr/bin/env python3
"""Clean up old KFP pipeline runs to reduce clutter in the OpenShift AI Pipelines UI."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from datetime import datetime, timezone


def get_kfp_token(token: str | None) -> str | None:
    """Resolve KFP auth token. Checks token arg, KFP_TOKEN env, then oc whoami -t."""
    if token:
        return token
    token = os.environ.get("KFP_TOKEN") or os.environ.get("OPENSHIFT_TOKEN")
    if token:
        return token
    try:
        r = subprocess.run(
            ["oc", "whoami", "-t"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return None


def list_all_runs(client, page_size: int = 50):
    """Yield all runs across pages."""
    token = ""
    while True:
        resp = client.list_runs(
            page_token=token,
            page_size=page_size,
            sort_by="created_at desc",
        )
        for r in resp.runs or []:
            yield r
        token = resp.next_page_token or ""
        if not token:
            break


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Delete or archive old KFP pipeline runs (OpenShift AI Pipelines)"
    )
    ap.add_argument(
        "--host",
        default=os.environ.get("KFP_HOST"),
        help="KFP API host (or set KFP_HOST)",
    )
    ap.add_argument(
        "--token",
        default=os.environ.get("KFP_TOKEN") or os.environ.get("OPENSHIFT_TOKEN"),
        help="Auth token for KFP API",
    )
    ap.add_argument(
        "--ds-project",
        default=os.environ.get("DS_PROJECT"),
        help="Data Science project namespace (for KFP_HOST auto-discovery)",
    )
    ap.add_argument(
        "--keep",
        type=int,
        default=10,
        help="Keep the N most recent runs (default: 10)",
    )
    ap.add_argument(
        "--older-than-days",
        type=int,
        default=None,
        help="Only touch runs older than N days (default: apply --keep logic to all)",
    )
    ap.add_argument(
        "--status",
        choices=["failed", "succeeded", "running", "skipped", "all"],
        default="all",
        help="Only touch runs with this status (default: all)",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="List runs that would be deleted/archived without making changes",
    )
    ap.add_argument(
        "--archive",
        action="store_true",
        help="Archive runs instead of deleting (hides from default view, reversible)",
    )
    ap.add_argument(
        "--delete",
        action="store_true",
        help="Permanently delete runs (default)",
    )
    ap.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help="Skip confirmation prompt",
    )
    args = ap.parse_args()

    host = args.host
    if not host:
        ds_project = args.ds_project or os.environ.get("DS_PROJECT")
        if ds_project:
            try:
                r = __import__("subprocess").run(
                    [
                        "oc",
                        "get",
                        "dspa",
                        "-n",
                        ds_project,
                        "-o",
                        "jsonpath={.items[0].status.components.apiServer.externalUrl}",
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if r.returncode == 0 and r.stdout.strip():
                    host = r.stdout.strip()
            except Exception:
                pass
        if not host:
            print("Set KFP_HOST or --ds-project. Get it from: oc get route -n <ds-project>", file=sys.stderr)
            sys.exit(1)

    token = get_kfp_token(args.token)
    if not token:
        print("Warning: No auth token. Run: oc login && export KFP_TOKEN=$(oc whoami -t)", file=sys.stderr)

    from kfp import client

    c = client.Client(host=host, existing_token=token)

    cutoff = None
    if args.older_than_days:
        from datetime import timedelta

        cutoff = datetime.now(timezone.utc) - timedelta(days=args.older_than_days)

    runs = []
    for run in list_all_runs(c):
        if args.status != "all":
            state = (run.state or "").lower()
            if args.status == "failed" and state != "failed":
                continue
            if args.status == "succeeded" and state != "succeeded":
                continue
            if args.status == "running" and state != "running":
                continue
            if args.status == "skipped" and state != "skipped":
                continue
        if cutoff and run.created_at:
            try:
                created = datetime.fromisoformat(run.created_at.replace("Z", "+00:00"))
                if created > cutoff:
                    continue
            except Exception:
                pass
        runs.append(run)

    # Keep N most recent, remove the rest
    runs.sort(key=lambda r: r.created_at or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    to_remove = runs[args.keep:]

    if not to_remove:
        print("No runs to clean up.")
        return

    use_archive = args.archive and not args.delete
    print(f"Would {'archive' if use_archive else 'delete'} {len(to_remove)} run(s):")
    for r in to_remove[:20]:
        created = r.created_at.strftime("%Y-%m-%d %H:%M") if r.created_at else "?"
        state = getattr(r, "state", "?") or "?"
        print(f"  {r.run_id}  {created}  {state}  {r.display_name or '-'}")
    if len(to_remove) > 20:
        print(f"  ... and {len(to_remove) - 20} more")

    if args.dry_run:
        print("\nDry run — no changes made. Run without --dry-run to apply.")
        return

    action = "archive" if use_archive else "delete"
    if not args.yes:
        print(f"\nProceed to {action} {len(to_remove)} run(s)? [y/N] ", end="")
        if input().strip().lower() != "y":
            print("Aborted.")
            return

    failed = 0
    for r in to_remove:
        try:
            if use_archive:
                c.archive_run(r.run_id)
                print(f"Archived {r.run_id}")
            else:
                c.delete_run(r.run_id)
                print(f"Deleted {r.run_id}")
        except Exception as e:
            print(f"Failed {r.run_id}: {e}", file=sys.stderr)
            failed += 1

    print(f"Done. {len(to_remove) - failed} {action}d, {failed} failed.")


if __name__ == "__main__":
    main()
