# Synesis NVFP4 Executor Pipeline
# Quantize DeepSeek-R1-Distill-70B with NVFP4, build ModelCar, push to ECR.
#
# Prerequisites:
#   - OpenShift AI Data Science Pipelines
#   - IRSA for pipeline SA with ECR push
#   - kaniko-ecr image built and pushed (see pipelines/kaniko-ecr/)
#   - hf-hub-secret for gated models
#
# Compile: python pipelines/nvfp4_executor_pipeline.py
# Upload nvfp4_executor_pipeline.yaml to OpenShift AI, then run.

from kfp import dsl
from kfp import kubernetes

# Kaniko-ECR image: build once and push to your ECR
# Default points to placeholder; override via pipeline param or env
KANIKO_ECR_IMAGE = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kaniko-ecr:latest"

NVFP4_RECIPE = """
quant_stage:
  quant_modifiers:
    QuantizationModifier:
      ignore: ["lm_head"]
      targets: ["Linear"]
      scheme: "NVFP4"
"""


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
def build_and_push_modelcar(
    input_model: dsl.Input[dsl.Artifact],
    ecr_uri: str,
    image_tag: str,
    kaniko_image: str = KANIKO_ECR_IMAGE,
):
    """Build ModelCar from quantized artifact and push to ECR. Uses IRSA."""
    return dsl.ContainerSpec(
        image=kaniko_image,
        command=["/usr/local/bin/ecr-login-and-kaniko.sh"],
        args=[input_model.path, ecr_uri, image_tag],
    )


@dsl.pipeline(
    name="synesis-nvfp4-executor",
    description="Quantize R1-Distill-70B with NVFP4, build ModelCar, push to ECR",
)
def nvfp4_executor_pipeline(
    model_id: str = "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
    dataset_id: str = "HuggingFaceH4/ultrachat_200k",
    dataset_split: str = "train_sft",
    ecr_uri: str = "123456789012.dkr.ecr.us-east-1.amazonaws.com/synesis-models",
    image_tag: str = "executor-nvfp4",
    kaniko_image: str = KANIKO_ECR_IMAGE,
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
    # Adjust toleration to match your GPU node taint
    kubernetes.add_toleration(
        quant_task,
        key="nvidia.com/gpu",
        operator="Equal",
        value="true",
        effect="NoSchedule",
    )

    build_task = build_and_push_modelcar(
        input_model=quant_task.outputs["output_model"],
        ecr_uri=ecr_uri,
        image_tag=image_tag,
        kaniko_image=kaniko_image,
    )
    build_task.set_cpu_request("1000m")
    build_task.set_memory_request("2Gi")
    build_task.set_cpu_limit("2000m")
    build_task.set_memory_limit("4Gi")
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

    out = __file__.replace(".py", ".yaml")
    compiler.Compiler().compile(
        pipeline_func=nvfp4_executor_pipeline,
        package_path=out,
    )
    print(f"Compiled to {out}")
