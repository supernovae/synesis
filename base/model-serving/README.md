# Model Serving

Synesis deploys GPU models via vLLM and loads weights from per-role PVCs. All model definitions, PVC names, and vLLM args are in [`models.yaml`](../../models.yaml).

## Model Roles

| Deployment | Role | GPU | PVC | Model |
|-----------|------|-----|-----|-------|
| synesis-supervisor-critic | Router | 1 × L40S | synesis-router-pvc | Qwen3-8B FP8 |
| synesis-executor | Critic | 1 × L40S | synesis-critic-pvc | R1-Distill-32B FP8 |
| synesis-coder | Coder | 1 × L40S | synesis-coder-pvc | Qwen3-Coder-Next |
| synesis-summarizer | Summarizer | CPU | (hf:// direct) | Qwen2.5-0.5B |

The Router deployment serves supervisor, planner, and advisor roles from a single model instance with different inference params (temperature, prompt) per request.

## Deployment Profiles

See `models.yaml` for small/medium/large profiles:

- **Small** (2 GPU): Router + Critic share GPU 0; Coder on GPU 1
- **Medium** (4 GPU): All roles dedicated
- **Large** (8 GPU): HPA auto-scaling for Coder

## Prerequisites

- OpenShift/ROSA with GPU node pool (`nvidia.com/gpu.product: NVIDIA-L40S`)
- Models downloaded to PVC: `./scripts/run-model-pipeline.sh --profile=small`
- Summarizer (optional, CPU): InferenceService with `connection-summarizer`

## Deploying

`./scripts/deploy.sh dev` applies everything. Or manually:

```bash
oc apply -n synesis-models -f base/model-serving/deployment-vllm-supervisor-critic.yaml
oc apply -n synesis-models -f base/model-serving/deployment-vllm-executor.yaml
oc apply -n synesis-models -f base/model-serving/deployment-vllm-coder.yaml
```

Verify:

```bash
oc get pods -n synesis-models
oc get deployments -n synesis-models
```

## Service Endpoints

| Service | URL | Role |
|---------|-----|------|
| synesis-supervisor | `http://synesis-supervisor.synesis-models.svc:8080/v1` | Router / Supervisor / Planner |
| synesis-critic | `http://synesis-critic.synesis-models.svc:8080/v1` | Critic (same backend as supervisor) |
| synesis-executor | `http://synesis-executor.synesis-models.svc:8080/v1` | Critic (R1 deep reasoning) |
| synesis-coder | `http://synesis-coder.synesis-models.svc:8080/v1` | Coder (IDE direct access) |

## Routes

| Route | Target | Purpose |
|-------|--------|---------|
| synesis-executor-api | synesis-executor | Direct IDE access to Coder endpoint |

## UDS (Unix Domain Socket)

When planner is co-located with models on the same GPU node, UDS reduces latency vs HTTP. See [docs/UDS_SETUP.md](../../docs/UDS_SETUP.md).

## Troubleshooting

- **No nodes available**: Ensure nodeSelector matches your GPU nodes (`oc get nodes -l nvidia.com/gpu.product=NVIDIA-L40S`)
- **OOM on model load**: Check vLLM args in the deployment YAML; reduce `--max-model-len` or use a smaller quantization
- **ImagePullBackOff**: Create `imagePullSecrets` if needed for registry access
- **PVC not found**: Run `./scripts/bootstrap-pipelines.sh` to create PVCs, then `./scripts/run-model-pipeline.sh --profile=small`
