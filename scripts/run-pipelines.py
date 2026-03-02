#!/usr/bin/env python3
"""Invoke Synesis pipelines on OpenShift AI. Download-only: models go to PVC, deployments load from PV."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PIPELINES_DIR = REPO_ROOT / "pipelines"

# Pipelines run in synesis-models so they use the same PVCs as deployments.
# DSPA may live in a different namespace (e.g. synesis); we discover KFP_HOST from there.
PIPELINE_NAMESPACE = "synesis-models"
DSPA_NAMESPACES = ("synesis", "synesis-models")  # Try in order when discovering KFP host


def compile_pipeline(name: str, ecr_uri: str | None = None) -> Path:
    """Compile pipeline to YAML. Pass ECR_URI to use model-pvc-download image."""
    env = os.environ.copy()
    if ecr_uri:
        env["ECR_URI"] = ecr_uri
    if name == "manager":
        script = PIPELINES_DIR / "manager_modelcar_pipeline.py"
        yaml_suffix = ".yaml"
    elif name == "executor":
        script = PIPELINES_DIR / "nvfp4_executor_pipeline.py"
        yaml_suffix = ".yaml"
    else:
        raise ValueError(f"Unknown pipeline: {name}")
    if not script.exists():
        raise FileNotFoundError(f"Pipeline script not found: {script}")
    subprocess.run(
        [sys.executable, str(script)],
        check=True,
        cwd=str(REPO_ROOT),
        env=env,
    )
    base = str(script).replace(".py", "")
    return Path(f"{base}{yaml_suffix}")


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


MANAGER_VALIDATE_MODEL_REPO = "Qwen/Qwen2.5-0.5B-Instruct"
MANAGER_VALIDATE_MODEL_NAME = "summarizer"


def run_pipeline(
    name: str,
    host: str,
    token: str | None = None,
    validate: bool = False,
) -> None:
    """Submit pipeline run via KFP client."""
    from kfp import client

    ecr_uri = os.environ.get("ECR_URI")
    yaml_path = compile_pipeline(name, ecr_uri=ecr_uri)
    if not yaml_path.exists():
        raise FileNotFoundError(f"Compiled pipeline not found: {yaml_path}")

    resolved_token = get_kfp_token(token)
    c = client.Client(host=host, existing_token=resolved_token, namespace=PIPELINE_NAMESPACE)
    print(f"Submitting run to namespace: {PIPELINE_NAMESPACE}", file=sys.stderr)

    if name == "manager":
        args = {
            "model_repo": os.environ.get("MODEL_REPO", "Qwen/Qwen2.5-32B-Instruct-AWQ"),
            "model_name": "manager",
            "pvc_name": os.environ.get("MODELCAR_PVC", "modelcar-build-pvc"),
        }
        if validate:
            args["model_repo"] = MANAGER_VALIDATE_MODEL_REPO
            args["model_name"] = MANAGER_VALIDATE_MODEL_NAME
            print(f"Validate (0.5B): {MANAGER_VALIDATE_MODEL_REPO}")
        run = c.create_run_from_pipeline_package(str(yaml_path), arguments=args)
    elif name == "executor":
        run = c.create_run_from_pipeline_package(
            str(yaml_path),
            arguments={
                "model_repo": os.environ.get(
                    "EXECUTOR_MODEL_REPO",
                    "dwetzel/DeepSeek-R1-Distill-Qwen-32B-GPTQ-INT4",
                ),
                "pvc_name": os.environ.get("EXECUTOR_PVC", "executor-build-pvc"),
            },
        )
    else:
        raise ValueError(f"Unknown pipeline: {name}")

    print(f"Run ID: {run.run_id}")
    print(f"URL: {host}/#/runs/details/{run.run_id}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Invoke Synesis pipelines (download to PVC)")
    ap.add_argument(
        "pipeline",
        choices=["manager", "executor", "all"],
        help="Pipeline to run",
    )
    ap.add_argument(
        "--validate",
        action="store_true",
        help="Manager: use 0.5B model for fast validation",
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
        help="(Unused) Pipelines always run in synesis-models for PVC consistency",
    )
    args = ap.parse_args()

    host = args.host
    if not host:
        # DSPA may be in synesis (where it's installed) or synesis-models
        for dspa_ns in DSPA_NAMESPACES:
            try:
                r = subprocess.run(
                    ["oc", "get", "dspa", "-n", dspa_ns, "-o", "jsonpath={.items[0].status.components.apiServer.externalUrl}"],
                    capture_output=True, text=True, check=False
                )
                if r.returncode == 0 and r.stdout.strip():
                    host = r.stdout.strip()
                    print(f"Using KFP host from DSPA in {dspa_ns}", file=sys.stderr)
                    break
                r = subprocess.run(
                    ["oc", "get", "route", "-n", dspa_ns, "-o", "jsonpath={.items[0].spec.host}"],
                    capture_output=True, text=True, check=False
                )
                if r.returncode == 0 and r.stdout.strip():
                    host = f"https://{r.stdout.strip()}"
                    print(f"Using KFP host from route in {dspa_ns}", file=sys.stderr)
                    break
            except Exception:
                pass
        if not host:
            print("Set KFP_HOST or pass --host", file=sys.stderr)
            sys.exit(1)

    token = get_kfp_token(args.token)
    if not token:
        print("Warning: No auth token. oc login && export KFP_TOKEN=$(oc whoami -t)", file=sys.stderr)

    if args.pipeline == "all":
        for p in ("manager", "executor"):
            print(f"\n--- Running {p} ---")
            run_pipeline(p, host, token=token, validate=args.validate)
    else:
        run_pipeline(args.pipeline, host, token=token, validate=args.validate)


if __name__ == "__main__":
    main()
