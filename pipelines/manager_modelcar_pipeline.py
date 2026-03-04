# Synesis Manager ModelCar Pipeline — download to PVC only (no OCI build/push).
#
# Download: Python pod pulls model to PVC at /data/models.
# Runtime: Deployments mount PVC, load directly from PV (faster than OCI pull on worker nodes).
#
# Prereq: Create PVC in DS project (same namespace as deployment):
#   oc apply -f pipelines/manifests/storage-class-gp3-high.yaml   # once, as cluster-admin
#   sed "s/NAMESPACE/<synesis-models>/" pipelines/manifests/modelcar-build-pvc.yaml | oc apply -f -
#
# Compile: python pipelines/manager_modelcar_pipeline.py
# Invoke: ./scripts/run-pipelines.sh manager
# Validate: ./scripts/run-pipelines.sh manager --validate  # 0.5B model, fast end-to-end test

import os
from kfp import dsl
from kfp import kubernetes

PVC_MOUNT_PATH = "/data"
_ECR = os.environ.get("ECR_URI")
UV_BASE = f"{_ECR}:model-pvc-download" if _ECR else "ghcr.io/astral-sh/uv:python3.12-trixie-slim"


@dsl.component(base_image=UV_BASE)
def cleanup_manager_pvc():
    """Remove old model files from PVC before downloading a new model."""
    import os
    import shutil

    model_dir = "/data/models"
    if os.path.isdir(model_dir):
        size_mb = sum(
            os.path.getsize(os.path.join(dp, f))
            for dp, _, fns in os.walk(model_dir)
            for f in fns
        ) / (1024 * 1024)
        print(f"Cleaning {model_dir} ({size_mb:.0f} MB)...")
        shutil.rmtree(model_dir)
        print("Cleanup complete")
    else:
        print(f"{model_dir} does not exist, nothing to clean")
    os.makedirs(model_dir, exist_ok=True)


@dsl.component(base_image=UV_BASE)
def download_model(model_repo: str):
    """Download HuggingFace model to PVC. Streams to disk, ~6Gi memory."""
    import subprocess

    subprocess.run(
        ["uv", "pip", "install", "-q", "huggingface_hub[hf_transfer]"],
        check=True,
    )

    import os

    out = "/data/models"
    os.makedirs(out, exist_ok=True)
    from huggingface_hub import snapshot_download

    print("Downloading", model_repo, "->", out)
    snapshot_download(
        repo_id=model_repo,
        local_dir=out,
        token=os.environ.get("HF_TOKEN") or None,
    )
    print("Done")


def _patch_yaml_deps(path: str) -> None:
    """Patch compiled YAML: use uv venv + uv pip instead of pip (no root, no pip)."""
    with open(path) as f:
        content = f.read()

    uv_bootstrap = (
        '- "\\nuv venv /tmp/venv && . /tmp/venv/bin/activate && '
        'uv pip install -q \\"kfp==2.16.0\\" \\"kubernetes>=8.0.0,<31\\" && '
        'exec \\"$0\\" \\"$@\\"\\n"'
    )
    start = content.find('- "\\nif ! [ -x')
    if start == -1:
        return
    end_marker = '$0\\" \\"$@\\"\\n"'
    end = content.find(end_marker, start)
    if end == -1:
        return
    end += len(end_marker)
    old_block = content[start:end]
    content = content.replace(old_block, uv_bootstrap)

    with open(path, "w") as f:
        f.write(content)


@dsl.pipeline(
    name="synesis-manager-modelcar",
    description="Manager: download model to PVC. Load from PV at runtime (no OCI).",
)
def manager_modelcar_pipeline(
    model_repo: str = "RedHatAI/Qwen3-8B-FP8-dynamic",
    model_name: str = "manager",
    pvc_name: str = "modelcar-build-pvc",
):
    cleanup_task = cleanup_manager_pvc()
    cleanup_task.set_caching_options(enable_caching=False)
    kubernetes.mount_pvc(
        cleanup_task,
        pvc_name=pvc_name,
        mount_path=PVC_MOUNT_PATH,
    )
    cleanup_task.set_cpu_request("500m")
    cleanup_task.set_memory_request("256Mi")
    cleanup_task.set_memory_limit("512Mi")

    download_task = download_model(model_repo=model_repo)
    download_task.set_caching_options(enable_caching=False)
    download_task.after(cleanup_task)
    kubernetes.mount_pvc(
        download_task,
        pvc_name=pvc_name,
        mount_path=PVC_MOUNT_PATH,
    )
    download_task.set_cpu_request("1000m")
    download_task.set_memory_request("4Gi")
    download_task.set_memory_limit("6Gi")
    kubernetes.use_secret_as_env(
        download_task,
        secret_name="hf-hub-secret",
        secret_key_to_env={"HF_TOKEN": "HF_TOKEN"},
        optional=True,
    )


if __name__ == "__main__":
    from kfp import compiler

    yaml_path = __file__.replace(".py", ".yaml")
    compiler.Compiler().compile(pipeline_func=manager_modelcar_pipeline, package_path=yaml_path)
    _patch_yaml_deps(yaml_path)
    print("Compiled to manager_modelcar_pipeline.yaml")