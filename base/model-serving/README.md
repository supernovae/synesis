# Model Serving

Synesis deploys GPU models via vLLM and loads weights from a shared EFS volume (`synesis-models-efs`). Model/provider routing is configured in Admin Model Registry; runtime services read those routes directly.

## Model Roles

| Deployment | Role | GPU | EFS Subpath | Model |
|-----------|------|-----|-------------|-------|
| synesis-router | Router | Operator-defined | router-model | Operator-defined |
| synesis-general | General | Operator-defined | general-model | Operator-defined |
| synesis-critic | Critic | Operator-defined | critic-model | Operator-defined |
| synesis-coder | Coder | Operator-defined | coder-model | Operator-defined |
| synesis-summarizer | Summarizer | CPU or optional GPU | (runtime-specific) | Operator-defined |

All models share a single PVC (`synesis-models-efs`) backed by AWS EFS via `efs-sc` StorageClass. Each deployment mounts a different `subPath`.

The Router deployment serves routing, query generation, planner, and advisor roles from a single model endpoint with role-specific inference params (temperature, prompt) per request.

## Capacity Planning

Plan model serving by explicit resource requests, replicas, and GPU availability rather than named profiles. Typical operators start with role-by-role single replicas, then scale horizontally or split endpoints as throughput and latency targets evolve.

## Prerequisites

- Kubernetes cluster with GPU-capable nodes (OpenShift/ROSA supported)
- EFS StorageClass (`efs-sc`) provisioned by Terraform
- Models downloaded to EFS role-by-role: `./scripts/run-model-pipeline.sh --role=<role> --model-repo=<hf-repo>`
- Summarizer (optional, CPU): InferenceService with `connection-summarizer`

## Deploying

Model serving is managed through Helm values. Enable or tune model-serving
workloads in your values file, then apply:

```bash
helm upgrade synesis ./charts/synesis -f my-synesis-values.yaml
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
| synesis-critic | `http://synesis-critic.synesis-models.svc:8080/v1` | Critic |
| synesis-general | `http://synesis-general.synesis-models.svc:8080/v1` | General / Worker / Writer |
| synesis-coder | `http://synesis-coder.synesis-models.svc:8080/v1` | Coder (IDE direct access) |

## Routes

| Route | Target | Purpose |
|-------|--------|---------|
| synesis-coder-api | synesis-coder | Direct IDE access to Coder endpoint |

## Planner Access

planner-ts reaches model endpoints through OpenAI-compatible HTTP routes resolved by the Model Registry. UDS-specific planner wiring has been retired.

## Troubleshooting

- **No nodes available**: Ensure Karpenter GPU node pool exists (`oc get nodepool gpu-l40-spot`)
- **OOM on model load**: Check vLLM args in the deployment YAML; reduce `--max-model-len` or `--max-num-seqs`
- **ImagePullBackOff**: Create `imagePullSecrets` if needed for registry access
- **PVC pending**: Check `oc get pvc synesis-models-efs -n synesis-models` and EFS CSI driver status
