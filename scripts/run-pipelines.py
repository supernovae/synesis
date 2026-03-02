#!/usr/bin/env python3
"""Invoke Synesis pipelines on OpenShift AI. All builds use Buildah."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PIPELINES_DIR = REPO_ROOT / "pipelines"


def compile_pipeline(name: str, ecr_uri: str | None = None) -> Path:
    """Compile pipeline to YAML. ECR_URI set so pipeline uses correct buildah-ecr image."""
    if name == "manager":
        script = PIPELINES_DIR / "manager_modelcar_pipeline.py"
        yaml_suffix = ".yaml"
    elif name == "manager-build-only":
        script = PIPELINES_DIR / "manager_modelcar_pipeline.py"
        yaml_suffix = "_build_only.yaml"
    elif name == "executor":
        script = PIPELINES_DIR / "nvfp4_executor_pipeline.py"
        yaml_suffix = ".yaml"
    elif name == "executor-build-only":
        script = PIPELINES_DIR / "nvfp4_executor_pipeline.py"
        yaml_suffix = "_build_only.yaml"
    else:
        raise ValueError(f"Unknown pipeline: {name}")
    if not script.exists():
        raise FileNotFoundError(f"Pipeline script not found: {script}")
    env = os.environ.copy()
    if ecr_uri:
        env["ECR_URI"] = ecr_uri
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
MANAGER_VALIDATE_IMAGE_TAG = "manager-0.5b"


def run_pipeline(
    name: str,
    host: str,
    ecr_uri: str,
    token: str | None = None,
    validate: bool = False,
) -> None:
    """Submit pipeline run via KFP client."""
    from kfp import client

    yaml_path = compile_pipeline(name, ecr_uri=ecr_uri)
    if not yaml_path.exists():
        raise FileNotFoundError(f"Compiled pipeline not found: {yaml_path}")

    resolved_token = get_kfp_token(token)
    c = client.Client(host=host, existing_token=resolved_token)

    if name == "manager":
        args = {
            "ecr_uri": ecr_uri,
            "model_repo": os.environ.get("MODEL_REPO", "nightmedia/Qwen3.5-35B-A3B-Text"),
            "image_tag": "manager",
            "model_name": "manager",
            "pvc_name": os.environ.get("MODELCAR_PVC", "modelcar-build-pvc"),
        }
        if validate:
            args["model_repo"] = MANAGER_VALIDATE_MODEL_REPO
            args["model_name"] = MANAGER_VALIDATE_MODEL_NAME
            args["image_tag"] = MANAGER_VALIDATE_IMAGE_TAG
            print(f"Validate (0.5B): {MANAGER_VALIDATE_MODEL_REPO} -> {ecr_uri}:{MANAGER_VALIDATE_IMAGE_TAG}")
        run = c.create_run_from_pipeline_package(str(yaml_path), arguments=args)
    elif name == "manager-build-only":
        run = c.create_run_from_pipeline_package(
            str(yaml_path),
            arguments={"pvc_name": os.environ.get("MODELCAR_PVC", "modelcar-build-pvc")},
        )
    elif name == "executor":
        run = c.create_run_from_pipeline_package(
            str(yaml_path),
            arguments={
                "ecr_uri": ecr_uri,
                "image_tag": "executor-nvfp4",
                "pvc_name": os.environ.get("EXECUTOR_PVC", "executor-build-pvc"),
            },
        )
    elif name == "executor-build-only":
        run = c.create_run_from_pipeline_package(
            str(yaml_path),
            arguments={
                "ecr_uri": ecr_uri,
                "image_tag": "executor-nvfp4",
                "pvc_name": os.environ.get("EXECUTOR_PVC", "executor-build-pvc"),
            },
        )
    else:
        raise ValueError(f"Unknown pipeline: {name}")

    print(f"Run ID: {run.run_id}")
    print(f"URL: {host}/#/runs/details/{run.run_id}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Invoke Synesis pipelines on OpenShift AI (Buildah)")
    ap.add_argument(
        "pipeline",
        choices=["manager", "manager-build-only", "executor", "executor-build-only", "all"],
        help="Pipeline to run (-build-only: resume without download/quant)",
    )
    ap.add_argument(
        "--validate",
        action="store_true",
        help="Manager: build 0.5B model for fast end-to-end validation",
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
        help="Data Science project namespace",
    )
    ap.add_argument(
        "--ecr-uri",
        default=os.environ.get("ECR_URI"),
        help="ECR repo URI (e.g. 660250927410.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry)",
    )
    ap.add_argument(
        "--ecr-registry",
        default=os.environ.get("ECR_REGISTRY"),
        help="Alternative: ECR registry; use with ECR_REPO",
    )
    ap.add_argument(
        "--ecr-repo",
        default=os.environ.get("ECR_REPO", "byron-ai-registry"),
        help="Repo name when using ECR_REGISTRY",
    )
    args = ap.parse_args()

    host = args.host
    if not host:
        ds_project = args.ds_project or os.environ.get("DS_PROJECT")
        if ds_project:
            try:
                r = subprocess.run(
                    ["oc", "get", "dspa", "-n", ds_project, "-o", "jsonpath={.items[0].status.components.apiServer.externalUrl}"],
                    capture_output=True, text=True, check=False
                )
                if r.returncode == 0 and r.stdout.strip():
                    host = r.stdout.strip()
                if not host:
                    r = subprocess.run(
                        ["oc", "get", "route", "-n", ds_project, "-o", "jsonpath={.items[0].spec.host}"],
                        capture_output=True, text=True, check=False
                    )
                    if r.returncode == 0 and r.stdout.strip():
                        host = f"https://{r.stdout.strip()}"
            except Exception:
                pass
        if not host:
            print("Set KFP_HOST or pass --host", file=sys.stderr)
            sys.exit(1)

    ecr_uri = args.ecr_uri or (args.ecr_registry and f"{args.ecr_registry}/{args.ecr_repo}")
    if not ecr_uri:
        print("Set ECR_URI or ECR_REGISTRY", file=sys.stderr)
        sys.exit(1)

    token = get_kfp_token(args.token)
    if not token:
        print("Warning: No auth token. oc login && export KFP_TOKEN=$(oc whoami -t)", file=sys.stderr)

    if args.pipeline == "all":
        for p in ("manager", "executor"):
            print(f"\n--- Running {p} ---")
            run_pipeline(p, host, ecr_uri, token=token, validate=args.validate)
    else:
        run_pipeline(args.pipeline, host, ecr_uri, token=token, validate=args.validate)


if __name__ == "__main__":
    main()
