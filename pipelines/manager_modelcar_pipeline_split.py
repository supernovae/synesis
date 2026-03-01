# Synesis Manager ModelCar Pipeline (Split) — download then build, avoids Kaniko OOM.
#
# Kaniko holds multi-stage build in memory (~40GiB for 35B model). This variant:
# 1. Download: Python pod pulls model to PVC (8Gi enough)
# 2. Build: Kaniko runs copy-only Dockerfile from PVC (much lower memory)
#
# Prereq: Create PVC in DS project:
#   oc create -f - <<EOF
#   apiVersion: v1
#   kind: PersistentVolumeClaim
#   metadata:
#     name: modelcar-build-pvc
#     namespace: <ds-project>
#   spec:
#     accessModes: [ReadWriteOnce]
#     resources:
#       requests:
#         storage: 100Gi
#     storageClassName: gp3   # or your cluster default
#   EOF
#
# Compile: python pipelines/manager_modelcar_pipeline_split.py
# Invoke: ./scripts/run-pipelines.sh manager-split

import os

from kfp import dsl
from kfp import kubernetes

_DEFAULT_BUILDER = "123456789012.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry:buildah-ecr"
BUILDAH_ECR_IMAGE = (
    f"{os.environ['ECR_URI']}:buildah-ecr"
    if os.environ.get("ECR_URI")
    else _DEFAULT_BUILDER
)

PVC_MOUNT_PATH = "/data"
# Build task: m6i.4xlarge (64 GiB) machine pool. 56Gi leaves headroom for kubelet; larger models need more.
_BUILD_MEMORY_LIMIT = "56Gi"


@dsl.component(base_image="python:3.12-slim")
def download_model(model_repo: str):
    """Download HuggingFace model to PVC. Lightweight — ~8Gi memory."""
    import subprocess
    import sys

    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "huggingface_hub[hf_transfer]"],
        check=True,
    )

    import os

    out = "/data/models"
    if os.path.isfile(os.path.join(out, "config.json")):
        print("Model already on PVC, skipping download")
        return
    os.makedirs(out, exist_ok=True)
    from huggingface_hub import snapshot_download

    print("Downloading", model_repo, "->", out)
    snapshot_download(
        repo_id=model_repo,
        local_dir=out,
        token=os.environ.get("HF_TOKEN") or None,
    )
    print("Done")


@dsl.container_component
def build_and_push_modelcar(
    model_name: str,
    ecr_uri: str,
    image_tag: str,
):
    """Build ModelCar from pre-downloaded model on PVC. Single-stage, low memory."""
    return dsl.ContainerSpec(
        image=BUILDAH_ECR_IMAGE,
        command=["sh", "-c", f"export CONTEXT_DIR={PVC_MOUNT_PATH} && exec /usr/local/bin/ecr-login-and-buildah-modelcar-pvc.sh \"$1\" \"$2\" \"$3\""],
        args=[ecr_uri, image_tag, model_name],
    )


_BUILD_CONFIG_BAKED = f"{os.environ.get('ECR_URI', '123456789012.dkr.ecr.us-east-1.amazonaws.com/synesis-models')}::manager::manager"


@dsl.container_component
def build_and_push_modelcar_baked():
    """Build ModelCar — ECR URI baked into command at compile time (DSP params broken)."""
    return dsl.ContainerSpec(
        image=BUILDAH_ECR_IMAGE,
        command=["sh", "-c", f"export CONTEXT_DIR={PVC_MOUNT_PATH} && /usr/local/bin/ecr-login-and-buildah-modelcar-pvc.sh '{_BUILD_CONFIG_BAKED}'"],
    )


@dsl.pipeline(
    name="synesis-manager-modelcar-split",
    description="Build Manager ModelCar (download to PVC, then Kaniko) — avoids OOM",
)
def manager_modelcar_pipeline_split(
    model_repo: str = "nightmedia/Qwen3.5-35B-A3B-Text",
    ecr_uri: str = "123456789012.dkr.ecr.us-east-1.amazonaws.com/synesis-models",
    image_tag: str = "manager",
    model_name: str = "manager",
    pvc_name: str = "modelcar-build-pvc",
):
    download_task = download_model(model_repo=model_repo)
    kubernetes.mount_pvc(
        download_task,
        pvc_name=pvc_name,
        mount_path=PVC_MOUNT_PATH,
    )
    download_task.set_cpu_request("1000m")
    download_task.set_memory_request("4Gi")
    download_task.set_memory_limit("8Gi")
    kubernetes.use_secret_as_env(
        download_task,
        secret_name="hf-hub-secret",
        secret_key_to_env={"HF_TOKEN": "HF_TOKEN"},
        optional=True,
    )

    build_task = build_and_push_modelcar(
        model_name=model_name,
        ecr_uri=ecr_uri,
        image_tag=image_tag,
    )
    build_task.after(download_task)
    kubernetes.mount_pvc(
        build_task,
        pvc_name=pvc_name,
        mount_path=PVC_MOUNT_PATH,
    )
    kubernetes.empty_dir_mount(build_task, volume_name="buildah-storage", mount_path="/var/lib/containers")
    build_task.set_cpu_request("2000m")
    build_task.set_memory_request("8Gi")
    build_task.set_memory_limit(_BUILD_MEMORY_LIMIT)
    kubernetes.set_image_pull_policy(build_task, "Always")
    kubernetes.use_secret_as_env(
        build_task,
        secret_name="aws-ecr-credentials",
        secret_key_to_env={
            "AWS_ACCESS_KEY_ID": "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY": "AWS_SECRET_ACCESS_KEY",
        },
    )
    kubernetes.use_secret_as_env(
        build_task,
        secret_name="aws-ecr-session-token",
        secret_key_to_env={"AWS_SESSION_TOKEN": "AWS_SESSION_TOKEN"},
        optional=True,
    )


@dsl.pipeline(
    name="synesis-manager-modelcar-split-build-only",
    description="Build only — assumes model already on PVC (resume after failed build)",
)
def manager_modelcar_pipeline_split_build_only(
    pvc_name: str = "modelcar-build-pvc",
):
    """Resume: run after manager-split download succeeded but build failed."""
    build_task = build_and_push_modelcar_baked()
    kubernetes.mount_pvc(
        build_task,
        pvc_name=pvc_name,
        mount_path=PVC_MOUNT_PATH,
    )
    kubernetes.empty_dir_mount(build_task, volume_name="buildah-storage", mount_path="/var/lib/containers")
    build_task.set_cpu_request("2000m")
    build_task.set_memory_request("8Gi")
    build_task.set_memory_limit(_BUILD_MEMORY_LIMIT)
    kubernetes.set_image_pull_policy(build_task, "Always")
    kubernetes.use_secret_as_env(
        build_task,
        secret_name="aws-ecr-credentials",
        secret_key_to_env={
            "AWS_ACCESS_KEY_ID": "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY": "AWS_SECRET_ACCESS_KEY",
        },
    )
    kubernetes.use_secret_as_env(
        build_task,
        secret_name="aws-ecr-session-token",
        secret_key_to_env={"AWS_SESSION_TOKEN": "AWS_SESSION_TOKEN"},
        optional=True,
    )


if __name__ == "__main__":
    from kfp import compiler

    compiler.Compiler().compile(
        pipeline_func=manager_modelcar_pipeline_split,
        package_path=__file__.replace(".py", ".yaml"),
    )
    compiler.Compiler().compile(
        pipeline_func=manager_modelcar_pipeline_split_build_only,
        package_path=__file__.replace(".py", "_build_only.yaml"),
    )
    print("Compiled to manager_modelcar_pipeline_split.yaml and _build_only.yaml")
