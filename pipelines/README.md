# Synesis Pipelines

Build Manager and Executor NVFP4 ModelCar images in OpenShift AI and push to ECR. **All heavy work runs in-cluster (AWS)** — no jump host.

## Pipelines

| Pipeline | Model | Steps | Runtime |
|----------|-------|-------|---------|
| **Manager** | Qwen3.5-35B-A3B | HF download → Buildah build → ECR | ~30 min |
| **Executor NVFP4** | DeepSeek-R1-Distill-70B | HF → LLM Compressor NVFP4 → Buildah → ECR | ~2–4 hr (GPU) |

**Node sizing:** Build tasks need 56Gi (m6i.4xlarge / 64 GiB node). Larger models may need a bigger machine pool.

**ECR layer limit:** ECR max layer size is ~50 GiB. Model files are split into multiple COPY layers automatically.

## Prerequisites

- OpenShift AI with Data Science Pipelines enabled
- IRSA for pipeline SA with ECR push (see docs/NVFP4_PIPELINE_ECR.md)
- GPU node for Executor quantization (70B needs ~80GB)
- `buildah-ecr` image built and pushed (see `buildah-ecr/`)
- `hf-hub-secret` in Data Science project (for gated models)

## Bootstrap (once)

```bash
export ECR_URI=660250927410.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry
export DS_PROJECT=your-data-science-project
export S3_BUCKET=byron-ai-d8a35264-rhoai-data   # pipeline artifacts — IRSA, no keys
export HF_TOKEN=hf_xxxx   # avoids HuggingFace rate limiting

./scripts/bootstrap-pipelines.sh
```

Creates ECR repo, buildah-ecr (Red Hat stack), hf-hub-secret, and pipeline server (DSPA) with S3 — no UI keys.

## Invoke Pipelines

From your laptop (work runs on cluster):

```bash
export KFP_HOST=https://<pipelines-route>   # oc get route -n <ds-project>
export ECR_URI=660250927410.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry

./scripts/run-pipelines.sh manager                 # Manager: HF → ModelCar → ECR
./scripts/run-pipelines.sh manager --validate      # 0.5B (fast) — validates pipeline
./scripts/run-pipelines.sh manager-split                 # Download→build, avoids OOM (~24Gi)
./scripts/run-pipelines.sh manager-split-build-only      # Resume build (no re-download)
./scripts/run-pipelines.sh executor-split                # Quant→copy→build (70B, needs 150Gi PVC)
./scripts/run-pipelines.sh executor-split-build-only     # Resume executor build
./scripts/run-pipelines.sh executor   # Executor: NVFP4 → ModelCar → ECR
./scripts/run-pipelines.sh all       # Both
```

Or use `ECR_REGISTRY` + `ECR_REPO` instead of `ECR_URI`.

Requires `pip install kfp` and `oc` logged in.

## Clean Up Old Runs

Keep the Pipelines UI manageable by deleting or archiving old runs:

```bash
export KFP_HOST=https://<pipelines-route>

./scripts/cleanup-pipeline-runs.sh --dry-run    # Preview what would be removed
./scripts/cleanup-pipeline-runs.sh --keep 5     # Keep 5 most recent, delete rest
./scripts/cleanup-pipeline-runs.sh --archive    # Archive instead of delete (reversible)
./scripts/cleanup-pipeline-runs.sh -y           # Skip confirmation
```

## Manual Compile / Upload

```bash
pip install -r pipelines/requirements.txt
python pipelines/manager_modelcar_pipeline.py
python pipelines/nvfp4_executor_pipeline.py
# Upload *.yaml to OpenShift AI Data Science Pipelines UI
```

## Files

- `manager_modelcar_pipeline.py` — Manager (HF download during build)
- `nvfp4_executor_pipeline.py` — Executor NVFP4
- `buildah-ecr/` — Build image (Red Hat: Buildah + AWS CLI). See [buildah-ecr/README.md](buildah-ecr/README.md)
