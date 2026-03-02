# Synesis NVFP4 Executor Pipeline — quant to PVC, then Buildah build.
#
# 1. Quant: NVFP4 with calibration data (GPU)
# 2. Copy: artifact → PVC at /data/executor-model
# 3. Build: Buildah from PVC with 10GB layers
#
# Prereq: PVC (150Gi for 70B quantized)
#   sed "s/NAMESPACE/<ds-project>/" pipelines/manifests/executor-build-pvc.yaml | oc apply -f -
#
# Invoke: ./scripts/run-pipelines.sh executor
# Resume: ./scripts/run-pipelines.sh executor-build-only

import os

from kfp import dsl
from kfp import kubernetes

_DEFAULT_BUILDER = "123456789012.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry:buildah-ecr"
BUILDAH_ECR_IMAGE = (
    f"{os.environ['ECR_URI']}:buildah-ecr"
    if os.environ.get("ECR_URI")
    else _DEFAULT_BUILDER
)

NVFP4_RECIPE = """
quant_stage:
  quant_modifiers:
    QuantizationModifier:
      ignore: ["lm_head"]
      targets: ["Linear"]
      scheme: "NVFP4"
"""

EXECUTOR_MODEL_PATH = "/data/executor-model"


@dsl.component(
    base_image="quay.io/opendatahub/llmcompressor-pipeline-runtime:main",
)
def run_nvfp4_calibrated(
    model_id: str,
    recipe: str,
    dataset_id: str,
    dataset_split: str,
    output_model: dsl.Output[dsl.Artifact],
    num_calibration_samples: int = 128,
    max_sequence_length: int = 2048,
    seed: int = 42,
):
    """Quantize model with NVFP4 (requires calibration data)."""
    from datasets import load_dataset
    from llmcompressor import oneshot
    from transformers import AutoModelForCausalLM, AutoTokenizer

    ds = load_dataset(dataset_id, split=dataset_split)
    ds = ds.shuffle(seed=seed).select(range(num_calibration_samples))

    tokenizer = AutoTokenizer.from_pretrained(model_id)

    def preprocess(example):
        return {
            "text": tokenizer.apply_chat_template(
                example["messages"],
                tokenize=False,
            )
        }

    ds = ds.map(preprocess)

    def tokenize(sample):
        return tokenizer(
            sample["text"],
            padding=False,
            max_length=max_sequence_length,
            truncation=True,
            add_special_tokens=False,
        )

    ds = ds.map(tokenize, remove_columns=ds.column_names)

    model = AutoModelForCausalLM.from_pretrained(
        model_id, device_map="auto", torch_dtype="auto"
    )
    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)

    model = oneshot(
        model=model,
        dataset=ds,
        recipe=recipe,
        tokenizer=tokenizer,
        max_seq_length=max_sequence_length,
        num_calibration_samples=num_calibration_samples,
    )

    model.save_pretrained(output_model.path, save_compressed=True)
    tokenizer.save_pretrained(output_model.path)
    return


@dsl.container_component
def copy_artifact_to_pvc(
    input_model: dsl.Input[dsl.Artifact],
):
    """Copy quant output to PVC for Buildah build."""
    return dsl.ContainerSpec(
        image="registry.access.redhat.com/ubi9/ubi-minimal:latest",
        command=["sh", "-c"],
        args=[
            r"mkdir -p /data/executor-model && cp -a $1/. /data/executor-model/",
            input_model.path,
        ],
    )


@dsl.container_component
def build_and_push_modelcar(
    ecr_uri: str,
    image_tag: str,
):
    """Build ModelCar from pre-copied model on PVC."""
    return dsl.ContainerSpec(
        image=BUILDAH_ECR_IMAGE,
        command=["/usr/local/bin/ecr-login-and-buildah.sh"],
        args=[EXECUTOR_MODEL_PATH, ecr_uri, image_tag],
    )


@dsl.pipeline(
    name="synesis-nvfp4-executor",
    description="Quantize 70B with NVFP4, copy to PVC, Buildah push to ECR (10GB layers)",
)
def nvfp4_executor_pipeline(
    model_id: str = "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
    dataset_id: str = "HuggingFaceH4/ultrachat_200k",
    dataset_split: str = "train_sft",
    ecr_uri: str = "123456789012.dkr.ecr.us-east-1.amazonaws.com/synesis-models",
    image_tag: str = "executor-nvfp4",
    pvc_name: str = "executor-build-pvc",
):
    quant_task = run_nvfp4_calibrated(
        model_id=model_id,
        recipe=NVFP4_RECIPE,
        dataset_id=dataset_id,
        dataset_split=dataset_split,
    )
    quant_task.set_accelerator_type("nvidia.com/gpu")
    quant_task.set_accelerator_limit("1")
    quant_task.set_cpu_request("2000m")
    quant_task.set_memory_request("24G")
    quant_task.set_cpu_limit("8000m")
    quant_task.set_memory_limit("80G")
    kubernetes.use_secret_as_env(
        quant_task,
        secret_name="hf-hub-secret",
        secret_key_to_env={"HF_TOKEN": "HF_TOKEN"},
    )
    kubernetes.add_toleration(
        quant_task,
        key="nvidia.com/gpu",
        operator="Equal",
        value="true",
        effect="NoSchedule",
    )

    copy_task = copy_artifact_to_pvc(input_model=quant_task.outputs["output_model"])
    copy_task.after(quant_task)
    kubernetes.mount_pvc(
        copy_task,
        pvc_name=pvc_name,
        mount_path="/data",
    )
    copy_task.set_cpu_request("1000m")
    copy_task.set_memory_request("2Gi")
    copy_task.set_memory_limit("4Gi")

    build_task = build_and_push_modelcar(ecr_uri=ecr_uri, image_tag=image_tag)
    build_task.after(copy_task)
    kubernetes.mount_pvc(
        build_task,
        pvc_name=pvc_name,
        mount_path="/data",
    )
    kubernetes.empty_dir_mount(build_task, volume_name="buildah-storage", mount_path="/var/lib/containers")
    build_task.set_cpu_request("2000m")
    build_task.set_memory_request("8Gi")
    build_task.set_memory_limit("56Gi")
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
    name="synesis-nvfp4-executor-build-only",
    description="Build only — executor model already on PVC (resume after failed build)",
)
def nvfp4_executor_pipeline_build_only(
    ecr_uri: str = "123456789012.dkr.ecr.us-east-1.amazonaws.com/synesis-models",
    image_tag: str = "executor-nvfp4",
    pvc_name: str = "executor-build-pvc",
):
    """Resume: run when quant+copy succeeded but build failed."""
    build_task = build_and_push_modelcar(ecr_uri=ecr_uri, image_tag=image_tag)
    kubernetes.mount_pvc(
        build_task,
        pvc_name=pvc_name,
        mount_path="/data",
    )
    kubernetes.empty_dir_mount(build_task, volume_name="buildah-storage", mount_path="/var/lib/containers")
    build_task.set_cpu_request("2000m")
    build_task.set_memory_request("8Gi")
    build_task.set_memory_limit("56Gi")
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
        pipeline_func=nvfp4_executor_pipeline,
        package_path=__file__.replace(".py", ".yaml"),
    )
    compiler.Compiler().compile(
        pipeline_func=nvfp4_executor_pipeline_build_only,
        package_path=__file__.replace(".py", "_build_only.yaml"),
    )
    print("Compiled to nvfp4_executor_pipeline.yaml and _build_only.yaml")
