#!/usr/bin/env python3
"""Create a one-shot Job from the indexer queue CronJob, with optional claim filters.

The CronJob template does not set SYNESIS_INDEXER_QUEUE_* env vars; this helper
merges them into the Job pod so a run can target a domain slice (e.g. go-only).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--namespace", required=True)
    ap.add_argument("--cronjob", required=True)
    ap.add_argument("--job-name", required=True)
    ap.add_argument("--queue-domain", default="", help="Set SYNESIS_INDEXER_QUEUE_DOMAIN")
    ap.add_argument("--queue-tag", default="", help="Set SYNESIS_INDEXER_QUEUE_TAG")
    ap.add_argument("--max-items", default="", help="Set SYNESIS_INDEXER_QUEUE_MAX_ITEMS (digits only)")
    args = ap.parse_args()

    raw = subprocess.check_output(
        ["oc", "-n", args.namespace, "get", "cronjob", args.cronjob, "-o", "json"],
        text=True,
    )
    cj_obj = json.loads(raw)
    jt = cj_obj["spec"]["jobTemplate"]
    job: dict = {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": args.job_name,
            "namespace": args.namespace,
            "labels": jt.get("metadata", {}).get("labels", {}),
            "annotations": jt.get("metadata", {}).get("annotations", {}),
        },
        "spec": jt["spec"],
    }
    container = job["spec"]["template"]["spec"]["containers"][0]
    env = list(container.get("env") or [])
    extra: list[dict[str, str]] = []
    if args.queue_domain.strip():
        extra.append({"name": "SYNESIS_INDEXER_QUEUE_DOMAIN", "value": args.queue_domain.strip()})
    if args.queue_tag.strip():
        extra.append({"name": "SYNESIS_INDEXER_QUEUE_TAG", "value": args.queue_tag.strip()})
    if args.max_items.strip():
        if not args.max_items.strip().isdigit():
            print("ERROR: --max-items must be a non-negative integer", file=sys.stderr)
            return 1
        extra.append({"name": "SYNESIS_INDEXER_QUEUE_MAX_ITEMS", "value": args.max_items.strip()})
    names = {e["name"] for e in extra}
    env = [e for e in env if e.get("name") not in names] + extra
    container["env"] = env

    proc = subprocess.run(
        ["oc", "-n", args.namespace, "apply", "-f", "-"],
        input=json.dumps(job).encode(),
        capture_output=True,
    )
    if proc.returncode != 0:
        sys.stderr.buffer.write(proc.stderr)
        return proc.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
