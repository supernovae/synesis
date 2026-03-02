# Blackwell / G6e Deployment

Deployments for Synesis on ROSA HCP. **G6e.4xlarge** (2× L40S, 96 GB total VRAM) is the current target. G7e (Blackwell RTX 6000) is not yet available on ROSA; when it lands, migration is straightforward.

## Topology (G6e)

- **Executor**: DeepSeek-R1-Distill-Qwen-32B **INT4** (~20GB + KV cache) — GPU 0; fits single L40S 48GB
- **Manager**: Qwen3.5-35B-A3B-Text (~70GB) — GPU 1; Supervisor + Planner + Critic (same model)
- **Planner**: Co-located on same node for UDS

Models load from **PVC** (no OCI). Pipelines download to PVC; deployments mount the same PVC. Faster than OCI pull on worker nodes (recommended by support).

## Prerequisites

1. **PVCs** created in the deployment namespace (same as pipeline runs):
   - `modelcar-build-pvc` (120Gi) — manager
   - `executor-build-pvc` (50Gi) — executor
2. **Models downloaded** via pipelines: `./scripts/run-pipelines.sh manager` and `./scripts/run-pipelines.sh executor`
3. GPU node pool with `nvidia.com/gpu.product: NVIDIA-L40S` (or adjust nodeSelector)

## Deploy

```bash
export NS=synesis-models   # must match where PVCs and pipeline runs live
oc create namespace $NS 2>/dev/null || true
oc create namespace synesis-planner 2>/dev/null || true

oc apply -n $NS -f pvc-vllm-sockets.yaml 2>/dev/null || true
oc apply -n $NS -f deployment-vllm-manager.yaml
oc apply -n $NS -f deployment-vllm-executor.yaml
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
