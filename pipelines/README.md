# Synesis Pipelines

Build Manager and Executor NVFP4 ModelCar images in OpenShift AI and push to ECR. **All builds use Buildah** (Red Hat stack). Heavy work runs in-cluster — no jump host.

## Pipelines

| Pipeline | Model | Steps | Runtime |
|----------|-------|-------|---------|
| **Manager** | Qwen3.5-35B-A3B | HF download → Buildah build+push → ECR (with PVC cleanup) | ~30 min |
| **Executor NVFP4** | DeepSeek-R1-Distill-70B | HF → NVFP4 quant → Buildah → ECR | ~2–4 hr (GPU) |

**Layer size:** 10 GiB per layer (universal: ECR Public, GHCR, ECR Private).

**Node sizing:** Manager build+push needs 72Gi memory, 80Gi emptyDir for Buildah. Create PVCs before running (see Prerequisites).

## Prerequisites

- OpenShift AI with Data Science Pipelines enabled
- IRSA for pipeline SA with ECR push
- GPU node for Executor quantization (70B needs ~80GB)
- `buildah-ecr` image (bootstrap builds and pushes it)
- `hf-hub-secret` in Data Science project (for gated models)
- PVCs: `modelcar-build-pvc` (400Gi, both 0.5B and 35B), `executor-build-pvc` (150Gi)

## Bootstrap (once)

```bash
export ECR_URI=660250927410.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry
export DS_PROJECT=your-data-science-project
export HF_TOKEN=hf_xxxx

./scripts/bootstrap-pipelines.sh
```

Then create PVCs:

```bash
sed "s/NAMESPACE/$DS_PROJECT/" pipelines/manifests/modelcar-build-pvc.yaml | oc apply -f -
sed "s/NAMESPACE/$DS_PROJECT/" pipelines/manifests/executor-build-pvc.yaml | oc apply -f -
```

## Invoke Pipelines

```bash
export KFP_HOST=https://<pipelines-route>
export ECR_URI=660250927410.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry

./scripts/run-pipelines.sh manager              # Manager: download → Buildah build+push → ECR
./scripts/run-pipelines.sh manager --validate   # 0.5B model — fast end-to-end test
./scripts/run-pipelines.sh manager-build-only   # Resume build (model already on PVC, skips download)
./scripts/run-pipelines.sh executor             # Quant → copy → Buildah → ECR
./scripts/run-pipelines.sh executor-build-only  # Resume executor build
./scripts/run-pipelines.sh all                  # Both manager and executor
```

Requires `pip install kfp` and `oc` logged in.

## Files

- `manager_modelcar_pipeline.py` — Manager: download to PVC, Buildah with 10GB layers
- `nvfp4_executor_pipeline.py` — Executor: NVFP4 quant, copy to PVC, Buildah
- `buildah-ecr/` — Build image (Buildah + AWS CLI). See [buildah-ecr/README.md](buildah-ecr/README.md)
