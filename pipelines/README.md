# Synesis Model Pipelines

Download models to per-role PVCs. Deployments mount these PVCs and load directly from persistent volumes — faster than OCI pull on worker nodes.

## Namespace: synesis-models

Pipelines, PVCs, and model deployments all use `synesis-models`. The scripts force pipeline runs into this namespace so they write to the same PVCs that deployments mount.

## Model Roles and PVCs

All model definitions, PVC names, and sizes come from [`models.yaml`](../models.yaml).

| Role | Default Model | PVC | Size |
|------|--------------|-----|------|
| **Router** | Qwen3-8B FP8 | `synesis-router-pvc` | 25Gi |
| **General** | Qwen3.5-35B-A3B | `synesis-general-pvc` | 100Gi |
| **Coder** | Qwen3-Coder-Next | `synesis-coder-pvc` | 200Gi |
| **Critic** | R1-Distill-32B FP8 | `synesis-critic-pvc` | 100Gi |
| **Summarizer** | Qwen2.5-0.5B | (none — KServe `hf://`) | — |

Storage class: `gp3-high` (16K IOPS, 1 GiB/s). PVC sizes include ~2.5x buffer over model weights for download working space.

## Prerequisites

- OpenShift AI with Data Science Pipelines (DSPA)
- `hf-hub-secret` in **synesis-models** (optional, for gated models)
- `gp3-high` StorageClass (apply once as cluster-admin):

```bash
oc apply -f pipelines/manifests/storage-class-gp3-high.yaml
```

## Bootstrap (once)

Create per-role PVCs:

```bash
./scripts/bootstrap-pipelines.sh
```

Or via `bootstrap.sh`:

```bash
./scripts/bootstrap.sh --hf-token   # creates PVCs + HuggingFace token
```

## Download Models

```bash
# All models for a profile
./scripts/run-model-pipeline.sh --profile=small

# Single role
./scripts/run-model-pipeline.sh --role=router
./scripts/run-model-pipeline.sh --role=coder
./scripts/run-model-pipeline.sh --role=critic
```

The script reads `models.yaml`, ensures the PVC exists, scales down any existing deployment, runs the download pipeline, then scales back up.

## Clean and Re-download

To switch models (e.g., upgrade Qwen3-8B to a newer version):

```bash
./scripts/cleanup-model-pvc.sh --role=router
./scripts/run-model-pipeline.sh --role=router
```

## Deploy

After download completes:

```bash
./scripts/deploy.sh dev
```

Or apply model-serving manifests directly:

```bash
oc apply -n synesis-models -f base/model-serving/deployment-vllm-router.yaml
oc apply -n synesis-models -f base/model-serving/deployment-vllm-critic.yaml
oc apply -n synesis-models -f base/model-serving/deployment-vllm-coder.yaml
```

## Files

| File | Purpose |
|------|---------|
| `model_pipeline.py` | Unified KFP pipeline: cleanup + download (parameterized by role) |
| `manifests/synesis-router-pvc.yaml` | Router PVC (25Gi) |
| `manifests/synesis-general-pvc.yaml` | General PVC (100Gi) |
| `manifests/synesis-coder-pvc.yaml` | Coder PVC (200Gi) |
| `manifests/synesis-critic-pvc.yaml` | Critic PVC (100Gi) |
| `manifests/storage-class-gp3-high.yaml` | gp3-high StorageClass |
| `model-pvc-download/` | Pipeline container (uv + hf_hub) |
