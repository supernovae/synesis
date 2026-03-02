# GPU Topology

How Synesis model serving uses GPU nodes for supervisor, critic, and executor.

## Current: 2× L40S (G6e)

**One GPU server** with 2× L40S. Two deployments split the GPUs:

| Deployment                 | Roles              | GPU | Notes                              |
|---------------------------|--------------------|-----|------------------------------------|
| synesis-supervisor-critic | Supervisor, Critic | 1   | Same model; different temps per request |
| synesis-executor          | Executor           | 1   | Code generation                    |

Both use `nodeSelector: nvidia.com/gpu.product: NVIDIA-L40S` so they schedule on the same node and each gets one GPU.

## Model Architecture

- **Supervisor** and **Critic**: One model instance, two logical roles. Planner sets temperature and prompt per call (e.g. temp 0.3 for supervisor, 0.1 for critic).
- **Executor**: Separate model (code gen); distinct deployment.

## Flexible Scaling

| Topology        | GPUs | Use case                          |
|-----------------|------|-----------------------------------|
| 2× L40S (now)  | 2    | G6e.4xlarge; default              |
| 4× L40S        | 4    | Scale executor replicas or split workloads |
| 1× Blackwell   | 1    | Future; single high-end GPU for all models (NVFP4) |

Adjust `nodeSelector`, `replicas`, and `resources` in `base/model-serving/deployment-vllm-*.yaml` as needed.

## Deployment Flow

1. **Bootstrap pipelines**: `./scripts/bootstrap-pipelines.sh` — PVCs, hf-hub-secret
2. **Run pipelines**: `./scripts/run-pipelines.sh manager` / `executor` / `all`
3. **Deploy**: `./scripts/deploy.sh dev` — applies model deployments + planner + gateway

Verify:

```bash
oc get pods -n synesis-models
oc get deployment synesis-supervisor-critic-predictor synesis-executor-predictor -n synesis-models
```

## UDS (low-latency, no OVN)

Planner and models co-locate on the same node. Planner uses Unix domain sockets instead of HTTP to talk to vLLM, avoiding cluster network traffic. See [UDS_SETUP.md](UDS_SETUP.md).

## Related

- [base/model-serving/README.md](../base/model-serving/README.md)
- [UDS_SETUP.md](UDS_SETUP.md) — UDS wiring and hostPath SCC
- [pipelines/README.md](../pipelines/README.md)
- [MODEL_SELECTION.md](MODEL_SELECTION.md)
