# Synesis Model Pipelines

Download models to a shared EFS volume. Deployments mount via `subPath` and load directly from persistent storage — faster than OCI pull on worker nodes. EFS is multi-AZ, so Karpenter has full flexibility to place GPU pods in whichever AZ has spot capacity.

## Namespace: synesis-models

Pipelines, PVC, and model deployments all use `synesis-models`. The scripts force pipeline runs into this namespace so they write to the same volume that deployments mount.

## Model Roles

Model downloads are now role-driven from CLI input and Registry assignments. All roles share a single EFS PVC (`synesis-models-efs`), each mounting its own `subPath`.

| Role | Default Model | subPath |
|------|--------------|---------|
| **Router** | Operator-selected in Registry | `router-model` |
| **General** | Operator-selected in Registry | `general-model` |
| **Coder** | Operator-selected in Registry | `coder-model` |
| **Critic** | Operator-selected in Registry | `critic-model` |
| **Summarizer** | Operator-selected in Registry | (optional local runtime) |

Storage: `efs-sc` StorageClass (provisioned by Terraform). EFS is elastic — no pre-provisioned size, pay only for stored data.

## Prerequisites

- Kubernetes with Kubeflow Pipelines API access
- Optional: OpenShift AI Data Science Pipelines (DSPA) for integrated OpenShift workflows
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
./scripts/run-model-pipeline.sh --role=router --model-repo=Qwen/Qwen2.5-14B-Instruct
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
# Role-by-role downloads
./scripts/run-model-pipeline.sh --role=router  --model-repo=Qwen/Qwen2.5-14B-Instruct
./scripts/run-model-pipeline.sh --role=general --model-repo=Qwen/Qwen3-32B-FP8
./scripts/run-model-pipeline.sh --role=coder   --model-repo=Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8
./scripts/run-model-pipeline.sh --role=critic  --model-repo=deepseek-ai/DeepSeek-R1-Distill-Qwen-32B
```

The script ensures the EFS PVC exists, scales down any existing deployment, runs the download pipeline, then scales back up.

## Re-download a Model

To switch models (e.g., upgrade Qwen3-8B to a newer version), re-run the pipeline for that role. The pipeline's cleanup step removes the old data from the EFS subpath before downloading:

```bash
./scripts/run-model-pipeline.sh --role=router --model-repo=Qwen/Qwen2.5-14B-Instruct
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
