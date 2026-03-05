# Model Serving

Synesis deploys GPU models via vLLM and loads weights from per-role PVCs. All model definitions, PVC names, and vLLM args are in [`models.yaml`](../../models.yaml).

## Model Roles

| Deployment | Role | GPU | PVC | Model |
|-----------|------|-----|-----|-------|
| synesis-router | Router | 1 × L40S | synesis-router-pvc | Qwen3-8B FP8 |
| synesis-general | General | 1 × L40S | synesis-general-pvc | Qwen3.5-35B-A3B FP8 |
| synesis-critic | Critic | 1 × L40S | synesis-critic-pvc | R1-Distill-32B FP8 |
| synesis-coder | Coder | 1 × L40S | synesis-coder-pvc | Qwen3-Coder-Next |
| synesis-summarizer | Summarizer | CPU | (hf:// direct) | Qwen2.5-0.5B |

The Router deployment serves supervisor, planner, and advisor roles from a single model instance with different inference params (temperature, prompt) per request. In small profile, it also serves the critic role via thinking mode.

## Deployment Profiles

See `models.yaml` for small/medium/large profiles:

- **Small** (3 GPU): Router+Critic on GPU 0 (Service alias); General on GPU 1; Coder on GPU 2
- **Medium** (4 GPU): All roles dedicated
- **Large** (8 GPU): HPA auto-scaling for Coder

## Prerequisites

- OpenShift/ROSA with GPU node pool (`nvidia.com/gpu.product: NVIDIA-L40S`)
- Models downloaded to PVC: `./scripts/run-model-pipeline.sh --profile=small`
- Summarizer (optional, CPU): InferenceService with `connection-summarizer`

## Deploying

`./scripts/deploy.sh dev` applies everything. Or manually:

```bash
oc apply -n synesis-models -f base/model-serving/deployment-vllm-router.yaml
oc apply -n synesis-models -f base/model-serving/deployment-vllm-critic.yaml
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
| synesis-router | `http://synesis-router.synesis-models.svc:8080/v1` | Router / Supervisor / Planner |
| synesis-critic | `http://synesis-critic.synesis-models.svc:8080/v1` | Critic (routes to router in small, R1 in medium+) |
| synesis-general | `http://synesis-general.synesis-models.svc:8080/v1` | General / Worker / Writer |
| synesis-coder | `http://synesis-coder.synesis-models.svc:8080/v1` | Coder (IDE direct access) |

## Routes

| Route | Target | Purpose |
|-------|--------|---------|
| synesis-coder-api | synesis-coder | Direct IDE access to Coder endpoint |

## UDS (Unix Domain Socket)

When planner is co-located with models on the same GPU node, UDS reduces latency vs HTTP. See [docs/UDS_SETUP.md](../../docs/UDS_SETUP.md).

## Troubleshooting

- **No nodes available**: Ensure nodeSelector matches your GPU nodes (`oc get nodes -l nvidia.com/gpu.product=NVIDIA-L40S`)
- **OOM on model load**: Check vLLM args in the deployment YAML; reduce `--max-model-len` or use a smaller quantization
- **ImagePullBackOff**: Create `imagePullSecrets` if needed for registry access
- **PVC not found**: Run `./scripts/bootstrap-pipelines.sh` to create PVCs, then `./scripts/run-model-pipeline.sh --profile=small`
