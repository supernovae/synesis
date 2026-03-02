# Blackwell / G6e Deployment

Deployments for Synesis on ROSA HCP. **G6e.4xlarge** (2× L40S, 96 GB total VRAM) is the current target. G7e (Blackwell RTX 6000) is not yet available on ROSA; when it lands, migration is straightforward.

## Topology (G6e)

- **Executor**: DeepSeek-R1-Distill-70B **NVFP4** (~40GB) — GPU 0; FP8 won't fit 48GB
- **Manager**: Qwen3.5-35B-A3B-Text (~18GB) — GPU 1; Supervisor + Planner + Critic (same model)
- **Planner**: Co-located on same node for UDS

See [MODEL_SELECTION.md](../../../docs/MODEL_SELECTION.md) and [NVFP4_PIPELINE_ECR.md](../../../docs/NVFP4_PIPELINE_ECR.md) for NVFP4 pipeline (in-cluster, no jump host) and multi-GPU options.

## Prerequisites

1. Mirror models to ECR: `./scripts/mirror-models-to-ecr.sh`
2. ECR_REGISTRY set (e.g. `123456789012.dkr.ecr.us-east-1.amazonaws.com`)
3. GPU node pool with `nvidia.com/gpu.product: NVIDIA-L40S` (or adjust nodeSelector)

## Deploy

```bash
export ECR_REGISTRY=123456789012.dkr.ecr.us-east-1.amazonaws.com
# Create ECR pull secret first (see docs/BLACKWELL_DEPLOYMENT.md)
./scripts/apply-blackwell-deployments.sh
```

Or manually:

```bash
export ECR_REGISTRY=123456789012.dkr.ecr.us-east-1.amazonaws.com
export EXECUTOR_IMAGE_TAG=executor   # or executor-nvfp4 for NVFP4
oc create namespace synesis-models 2>/dev/null || true
oc create namespace synesis-planner 2>/dev/null || true
oc apply -n synesis-models -f pvc-vllm-sockets.yaml
envsubst < deployment-vllm-executor.yaml | oc apply -n synesis-models -f -
envsubst < deployment-vllm-manager.yaml | oc apply -n synesis-models -f -
oc apply -n synesis-planner -f deployment-planner-gpu.yaml
```

## URLs for Planner config

When using Manager cluster (Supervisor + Critic share one model):

- `SYNESIS_SUPERVISOR_MODEL_URL` → `http://synesis-manager-predictor.synesis-models.svc.cluster.local:8080/v1`
- `SYNESIS_PLANNER_MODEL_URL` → same
- `SYNESIS_CRITIC_MODEL_URL` → same
- `SYNESIS_EXECUTOR_MODEL_URL` → `http://synesis-executor-predictor.synesis-models.svc.cluster.local:8080/v1`

## UDS (optional)

For lowest latency when Planner and vLLM share a node:

1. Use PVC for vllm-sockets in both vLLM and Planner deployments.
2. Add `--uds=/tmp/vllm/executor.sock` to Executor, `--uds=/tmp/vllm/manager.sock` to Manager.
3. Set `SYNESIS_*_MODEL_UDS` in Planner env (see deployment-planner-gpu.yaml comments).

Note: vLLM with `--uds` does not listen on port; use UDS or HTTP, not both.
