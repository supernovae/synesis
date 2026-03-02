# Synesis Executor Pipeline — download pre-quantized INT4 to PVC only (no OCI build/push).
#
# Download: HF model → PVC at /data/executor-model.
# Runtime: Deployments mount PVC, load directly from PV (faster than OCI pull on worker nodes).
#
# Uses dwetzel/DeepSeek-R1-Distill-Qwen-32B-GPTQ-INT4 — no quantization step.
# 32B INT4 ~18GB fits single L40S with KV cache.
#
# Prereq: PVC in same namespace as deployment:
#   oc apply -f pipelines/manifests/storage-class-gp3-high.yaml   # once
#   sed "s/NAMESPACE/<synesis-models>/" pipelines/manifests/executor-build-pvc.yaml | oc apply -f -
#
# Invoke: ./scripts/run-pipelines.sh executor

import os
from kfp import dsl
from kfp import kubernetes

DEFAULT_EXECUTOR_MODEL = "dwetzel/DeepSeek-R1-Distill-Qwen-32B-GPTQ-INT4"
_ECR = os.environ.get("ECR_URI")
UV_BASE = f"{_ECR}:model-pvc-download" if _ECR else "ghcr.io/astral-sh/uv:python3.12-trixie-slim"


@dsl.component(base_image=UV_BASE)
def download_executor_model(model_repo: str):
    """Download pre-quantized INT4 model from HuggingFace to PVC. No GPU needed."""
    import subprocess

    subprocess.run(
        ["uv", "pip", "install", "-q", "huggingface_hub[hf_transfer]"],
        check=True,
    )

    import os

    out = "/data/executor-model"  # Must be inline — KFP serializes component without module constants
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


def _patch_yaml_deps(path: str) -> None:
    """Patch compiled YAML: use uv venv + uv pip instead of pip."""
    with open(path) as f:
        content = f.read()
    uv_bootstrap = (
        '- "\\nuv venv /opt/venv && . /opt/venv/bin/activate && '
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
    name="synesis-executor-int4",
    description="Executor: download INT4 model to PVC. Load from PV at runtime (no OCI).",
)
def executor_pipeline(
    model_repo: str = DEFAULT_EXECUTOR_MODEL,
    pvc_name: str = "executor-build-pvc",
):
    download_task = download_executor_model(model_repo=model_repo)
    download_task.set_caching_options(enable_caching=False)
    kubernetes.mount_pvc(
        download_task,
        pvc_name=pvc_name,
        mount_path="/data",
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


if __name__ == "__main__":
    from kfp import compiler

    yaml_path = __file__.replace(".py", ".yaml")
    compiler.Compiler().compile(pipeline_func=executor_pipeline, package_path=yaml_path)
    _patch_yaml_deps(yaml_path)
    print("Compiled to nvfp4_executor_pipeline.yaml")