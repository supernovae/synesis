# Synesis Manager ModelCar Pipeline
# Download model from HuggingFace during Kaniko build, push to ECR.
# All work happens in-cluster (AWS network) — no jump host needed.
#
# Prerequisites:
#   - OpenShift AI Data Science Pipelines
#   - IRSA for pipeline SA with ECR push
#   - kaniko-ecr image built with modelcar-src (see pipelines/kaniko-ecr/)
#   - hf-hub-secret for gated models (optional for public)
#
# Compile: python pipelines/manager_modelcar_pipeline.py
# Invoke: ./scripts/run-pipelines.sh manager

import os

from kfp import dsl
from kfp import kubernetes

# Kaniko builder image. At compile time, if ECR_URI env is set (by run-pipelines),
# use {ECR_URI}:kaniko-ecr. Otherwise use default placeholder.
_DEFAULT_KANIKO = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kaniko-ecr:latest"
KANIKO_ECR_IMAGE = (
    f"{os.environ['ECR_URI']}:kaniko-ecr"
    if os.environ.get("ECR_URI")
    else _DEFAULT_KANIKO
)


@dsl.container_component
def build_and_push_manager_modelcar(
    model_repo: str,
    ecr_uri: str,
    image_tag: str = "manager",
    model_name: str = "manager",
    kaniko_image: str = KANIKO_ECR_IMAGE,
):
    """Build ModelCar from HF (download during build), push to ECR. Uses IRSA."""
    # Image must be constant: KFP fails when image is a pipeline parameter.
    # Override default by editing KANIKO_ECR_IMAGE or rebuilding the pipeline.
    return dsl.ContainerSpec(
        image=KANIKO_ECR_IMAGE,
        command=["sh", "/usr/local/bin/ecr-login-and-kaniko-modelcar.sh"],
        args=[model_repo, model_name, ecr_uri, image_tag],
    )


@dsl.pipeline(
    name="synesis-manager-modelcar",
    description="Build Manager ModelCar (HF download during build), push to ECR",
)
def manager_modelcar_pipeline(
    model_repo: str = "nightmedia/Qwen3.5-35B-A3B-Text",
    ecr_uri: str = "123456789012.dkr.ecr.us-east-1.amazonaws.com/synesis-models",
    image_tag: str = "manager",
    model_name: str = "manager",
    kaniko_image: str = KANIKO_ECR_IMAGE,
):
    task = build_and_push_manager_modelcar(
        model_repo=model_repo,
        ecr_uri=ecr_uri,
        image_tag=image_tag,
        model_name=model_name,
        kaniko_image=kaniko_image,
    )
    task.set_cpu_request("4000m")
    task.set_memory_request("16Gi")
    task.set_cpu_limit("8000m")
    task.set_memory_limit("48Gi")
    # Always pull so rebuilds (same tag) are picked up; avoids stale cached image.
    kubernetes.set_image_pull_policy(task, "Always")
    # AWS creds for ECR push. Pipeline uses aws-ecr-credentials secret — NOT your laptop STS.
    # Create: ./scripts/sync-ecr-credentials.sh  (after aws sso login)
    # Or: oc create secret generic aws-ecr-credentials -n <ds-project> \
    #       --from-literal=AWS_ACCESS_KEY_ID=AKIA... \
    #       --from-literal=AWS_SECRET_ACCESS_KEY=...
    # For SSO: sync script also creates aws-ecr-session-token with AWS_SESSION_TOKEN.
    kubernetes.use_secret_as_env(
        task,
        secret_name="aws-ecr-credentials",
        secret_key_to_env={
            "AWS_ACCESS_KEY_ID": "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY": "AWS_SECRET_ACCESS_KEY",
        },
    )
    kubernetes.use_secret_as_env(
        task,
        secret_name="aws-ecr-session-token",
        secret_key_to_env={"AWS_SESSION_TOKEN": "AWS_SESSION_TOKEN"},
        optional=True,
    )
    # Optional: create hf-hub-secret with HF_TOKEN for gated models
    kubernetes.use_secret_as_env(
        task,
        secret_name="hf-hub-secret",
        secret_key_to_env={"HF_TOKEN": "HF_TOKEN"},
        optional=True,
    )


if __name__ == "__main__":
    from kfp import compiler

    out = __file__.replace(".py", ".yaml")
    compiler.Compiler().compile(
        pipeline_func=manager_modelcar_pipeline,
        package_path=out,
    )
    print(f"Compiled to {out}")
