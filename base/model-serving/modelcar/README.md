# ModelCar (OCI) Model Images for ECR

ModelCar images package HuggingFace model weights into OCI-compliant container images for fast, cache-friendly pulls from Amazon ECR. Used with RHOAI 3.2 and the ModelCar deployment pattern.

## Layout

- **Dockerfile** — Multi-stage: downloads from HF, copies to ubi9-minimal. Model at `/models`.
- **download_model.py** — Uses `huggingface_hub.snapshot_download`; `MODEL_REPO` and `HF_TOKEN` from env.
- **Mirror script** — `scripts/mirror-models-to-ecr.sh` builds and pushes to ECR.

## Build (standalone)

```bash
# Public model
docker build -f base/model-serving/modelcar/Dockerfile \
  --build-arg MODEL_REPO=Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8 \
  --build-arg MODEL_NAME=synesis-executor \
  -t my-registry/synesis-models:executor .

# Gated model (HF_TOKEN)
docker build -f base/model-serving/modelcar/Dockerfile \
  --build-arg MODEL_REPO=RedHatAI/Qwen3-8B-FP8-dynamic \
  --build-arg MODEL_NAME=synesis-supervisor \
  --build-arg HF_TOKEN=$HF_TOKEN \
  -t my-registry/synesis-models:supervisor .
```

## Mirror to ECR (jump host)

```bash
export ECR_REGISTRY=123456789012.dkr.ecr.us-east-1.amazonaws.com
export AWS_REGION=us-east-1
export HF_TOKEN=hf_xxx   # optional
./scripts/mirror-models-to-ecr.sh
```

Ensure ECR repo exists:

```bash
aws ecr create-repository --repository-name synesis-models --region $AWS_REGION
```

## Deployment

Use `base/model-serving/deployment-modelcar-executor.yaml` as the template. Override `ECR_REGISTRY` for your account/region, then apply. The deployment uses:

- **Init container** — Copies `/models` from the ModelCar image to an `emptyDir` volume.
- **vLLM container** — RHOAI vLLM CUDA image; loads from `/mnt/models`.
- **Volumes** — `shm` (32Gi Memory) for NCCL; `vllm-sockets` for UDS when configured.

## VPC Endpoint

Use an **ECR Interface VPC Endpoint** so worker nodes pull images without NAT Gateway. Reduces cost and improves startup time.
