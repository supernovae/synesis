#!/usr/bin/env python3
"""Quality-runner CronJob entrypoint.

Runs the corpus audit (and optionally the curator agent), then POSTs the
audit JSON to the admin ``/api/v1/rag/quality/import-report`` endpoint so
domain health data lands in Postgres without needing a shared volume.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import httpx

ADMIN_API_URL = os.getenv("SYNESIS_ADMIN_API_URL", "http://synesis-admin.synesis-admin.svc.cluster.local:8000")
MILVUS_URI = os.getenv("SYNESIS_MILVUS_URI", "http://synesis-milvus.synesis-rag.svc.cluster.local:19530")
EMBEDDER_URL = os.getenv("SYNESIS_EMBEDDER_URL", "http://embedder.synesis-rag.svc.cluster.local:8080")
LLM_URL = os.getenv("SYNESIS_LLM_URL", "")
LLM_MODEL = os.getenv("SYNESIS_LLM_MODEL", "synesis-general")
TAXONOMY_PATH = os.getenv("SYNESIS_TAXONOMY_PATH", "/app/taxonomy_prompt_config.yaml")
AUDIT_OUTPUT = "/tmp/corpus_audit_report.json"
CURATOR_OUTPUT = "/tmp/proposed_sources.yaml"
RUN_CURATOR = os.getenv("SYNESIS_RUN_CURATOR", "false").lower() in ("1", "true", "yes")
API_TOKEN = os.getenv("SYNESIS_API_TOKEN", "")


def run_audit() -> bool:
    cmd = [
        sys.executable, "benchmarks/corpus/audit_corpus.py",
        "--milvus-uri", MILVUS_URI,
        "--embedder-url", EMBEDDER_URL,
        "--taxonomy", TAXONOMY_PATH,
        "--output", AUDIT_OUTPUT,
    ]
    if LLM_URL:
        cmd += ["--llm-url", LLM_URL, "--model", LLM_MODEL]
    print(f"[quality-runner] Running audit: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    print(result.stdout[-2000:] if result.stdout else "")
    if result.returncode != 0:
        print(f"[quality-runner] Audit failed (exit {result.returncode}):\n{result.stderr[-2000:]}", file=sys.stderr)
        return False
    return True


def run_curator() -> bool:
    if not os.path.exists(AUDIT_OUTPUT):
        print("[quality-runner] No audit report; skipping curator.")
        return False
    cmd = [
        sys.executable, "tools/curator/curator_agent.py",
        "--audit-report", AUDIT_OUTPUT,
        "--taxonomy", TAXONOMY_PATH,
        "--output", CURATOR_OUTPUT,
    ]
    if LLM_URL:
        cmd += ["--llm-url", LLM_URL, "--model", LLM_MODEL]
    print(f"[quality-runner] Running curator: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    print(result.stdout[-2000:] if result.stdout else "")
    if result.returncode != 0:
        print(f"[quality-runner] Curator failed (exit {result.returncode}):\n{result.stderr[-2000:]}", file=sys.stderr)
        return False
    return True


def post_report_to_admin() -> bool:
    if not os.path.exists(AUDIT_OUTPUT):
        print("[quality-runner] No audit report to POST.")
        return False
    with open(AUDIT_OUTPUT) as f:
        report = json.load(f)
    url = f"{ADMIN_API_URL.rstrip('/')}/api/v1/rag/quality/import-report"
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if API_TOKEN:
        headers["Authorization"] = f"Bearer {API_TOKEN}"
    try:
        resp = httpx.post(url, json=report, headers=headers, timeout=30.0)
        resp.raise_for_status()
        data = resp.json()
        print(f"[quality-runner] Import response: {data}")
        return data.get("ok", False)
    except Exception as exc:
        print(f"[quality-runner] Import failed: {exc}", file=sys.stderr)
        return False


def main() -> int:
    audit_ok = run_audit()
    if not audit_ok:
        return 1

    import_ok = post_report_to_admin()
    if not import_ok:
        print("[quality-runner] Warning: import to admin failed; audit ran but results not persisted.")

    if RUN_CURATOR:
        run_curator()

    return 0


if __name__ == "__main__":
    sys.exit(main())
