# Model Serving

Synesis uses two GPU deployments that split across 2× L40S on a single G6e server. Models load from PVC (pipelines download to PV).

## Topology (2–4 GPUs)

| Deployment                 | Roles              | GPU | nodeSelector   | PVC                    |
|---------------------------|--------------------|-----|----------------|------------------------|
| synesis-supervisor-critic | Supervisor, Critic | 1   | NVIDIA-L40S    | modelcar-build-pvc     |
| synesis-executor          | Executor           | 1   | NVIDIA-L40S    | executor-build-pvc     |

**Supervisor + Critic**: One model instance serves both roles. Same weights; different inference params (e.g. temperature) per request. Planner sets temp per call.

**Flexible scaling**:
- **2 GPUs (default)**: Supervisor-critic on GPU 0, Executor on GPU 1
- **4 GPUs**: Adjust replicas or nodeSelector; document in `docs/GPU_TOPOLOGY.md`
- **Future (Blackwell)**: Single high-end GPU can host all models; parameterize when available

## Prerequisites

- OpenShift/ROSA with GPU node pool (`nvidia.com/gpu.product: NVIDIA-L40S`)
- Models on PVC: `./scripts/bootstrap-pipelines.sh` then `./scripts/run-pipelines.sh manager` / `executor` / `all`
- Summarizer (optional, CPU): InferenceService with `connection-summarizer`

## Deploying

`./scripts/deploy.sh dev` applies everything:

- **Deployments**: `synesis-supervisor-critic-predictor`, `synesis-executor-predictor` (PVC, L40S)
- **Services**: `synesis-supervisor-predictor`, `synesis-critic-predictor` (both → supervisor-critic), `synesis-executor-predictor`
- **Summarizer** (InferenceService, vllm-cpu): `synesis-summarizer` (hf://)

Verify:

```bash
oc get pods -n synesis-models
oc get deployment synesis-supervisor-critic-predictor synesis-executor-predictor -n synesis-models
```

## UDS (Unix Domain Socket)

When planner is co-located with models on the same GPU node, it uses UDS instead of HTTP for lower latency and no OVN traffic. Each vLLM pod has a socat sidecar listening on `/var/lib/synesis/vllm-sockets/*.sock`; planner mounts the same hostPath. See [docs/UDS_SETUP.md](../../docs/UDS_SETUP.md).

## Configuring Synesis (HTTP fallback)

When UDS is not used, planner and gateway use these endpoints:

- **Supervisor / Planner**: `http://synesis-supervisor-predictor.synesis-models.svc.cluster.local:8080/v1`
- **Critic**: `http://synesis-critic-predictor.synesis-models.svc.cluster.local:8080/v1` (same backend as supervisor)
- **Executor**: `http://synesis-executor-predictor.synesis-models.svc.cluster.local:8080/v1`

Model name for critic: `synesis-supervisor` (same model; planner sets temperature per role).

## Troubleshooting

- **No nodes available**: Ensure nodeSelector matches your GPU nodes (`oc get nodes -l nvidia.com/gpu.product=NVIDIA-L40S`)
- **OOM on Executor**: Use NVFP4 pipeline or reduce `--max-model-len`
- **ImagePullBackOff**: Create `imagePullSecrets` if needed for registry access
