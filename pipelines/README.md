# Synesis Model Pipelines

Download models to a shared EFS volume. Deployments mount via `subPath` and load directly from persistent storage — faster than OCI pull on worker nodes. EFS is multi-AZ, so Karpenter has full flexibility to place GPU pods in whichever AZ has spot capacity.

## Namespace: synesis-models

Pipelines, PVC, and model deployments all use `synesis-models`. The scripts force pipeline runs into this namespace so they write to the same volume that deployments mount.

## Model Roles

All model definitions and subpaths come from [`models.yaml`](../models.yaml). All roles share a single EFS PVC (`synesis-models-efs`), each mounting its own `subPath`.

| Role | Default Model | subPath |
|------|--------------|---------|
| **Router** | Qwen3-8B FP8 | `router-model` |
| **General** | Qwen3.5-35B-A3B | `general-model` |
| **Coder** | Qwen3-Coder-30B-A3B FP8 | `coder-model` |
| **Critic** | R1-Distill-32B FP8 | `critic-model` |
| **Summarizer** | Qwen2.5-0.5B | (none — KServe `hf://`) |

Storage: `efs-sc` StorageClass (provisioned by Terraform). EFS is elastic — no pre-provisioned size, pay only for stored data.

## Prerequisites

- OpenShift AI with Data Science Pipelines (DSPA)
- `efs-sc` StorageClass on the cluster (Terraform)
- `hf-hub-secret` in **synesis-models** (optional, for gated models)

## Bootstrap (once)

Creates the shared EFS PVC and HuggingFace secret:

```bash
./scripts/bootstrap-pipelines.sh
```

Or via `bootstrap.sh`:

```bash
./scripts/bootstrap.sh --hf-token   # creates PVC + HuggingFace token
```

## KFP Connection (KFP_HOST & KFP_TOKEN)

`run-model-pipeline.sh` needs to reach the Kubeflow Pipelines API server. It tries auto-discovery first, but you can set the values explicitly.

**Auto-discovery (recommended):** just be logged into `oc` and the script handles the rest:

```bash
oc login ...                      # ensure you have an active session
./scripts/run-model-pipeline.sh --profile=small
```

The script discovers `KFP_HOST` from the DSPA status in `synesis-models`, and gets the token via `oc whoami -t`.

**Manual override:** if auto-discovery fails (e.g. DSPA route not ready, non-standard namespace):

```bash
# From DSPA status (preferred)
export KFP_HOST=$(oc get dspa -n synesis-models -o jsonpath='{.items[0].status.components.apiServer.externalUrl}')

# Fallback: from route
export KFP_HOST=https://$(oc get route -n synesis-models -o jsonpath='{.items[0].spec.host}')

# Token from your oc session
export KFP_TOKEN=$(oc whoami -t)
```

**Troubleshooting:**

| Symptom | Fix |
|---------|-----|
| `ERROR: Set KFP_HOST` | DSPA not ready or you're not logged in. Run `oc get dspa -n synesis-models` to check. |
| `401 Unauthorized` | Token expired. Run `oc login` again, then `export KFP_TOKEN=$(oc whoami -t)`. |
| `Connection refused` | DSPA pod may not be running. Check `oc get pods -n synesis-models \| grep dspa`. |

## Download Models

```bash
# All models for a profile
./scripts/run-model-pipeline.sh --profile=small

# Single role
./scripts/run-model-pipeline.sh --role=router
./scripts/run-model-pipeline.sh --role=coder
./scripts/run-model-pipeline.sh --role=critic
```

The script ensures the EFS PVC exists, scales down any existing deployment, runs the download pipeline, then scales back up.

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
| `manifests/synesis-models-efs-pvc.yaml` | Shared EFS PVC for all model weights |
| `model-pvc-download/` | Pipeline container (uv + hf_hub) |
