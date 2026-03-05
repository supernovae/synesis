# GPU Topology

How Synesis model serving uses GPU nodes for supervisor, critic, and executor.

## Current: 2x L40S (G6e.4xlarge)

**One GPU server** with 2x L40S (48GB each, 96GB total). Two deployments split the GPUs:

| Deployment                 | Model                                          | Roles              | GPU | Notes                              |
|---------------------------|-------------------------------------------------|--------------------|-----|------------------------------------|
| synesis-supervisor-critic | Qwen3-8B FP8-dynamic                            | Supervisor, Planner, Critic | 1   | Shared model; different temps/prompts per request |
| synesis-executor          | DeepSeek R1-Distill-Qwen-32B FP8-dynamic       | Executor (Worker)  | 1   | Code generation + knowledge Q&A   |

Summarizer (Qwen2.5-0.5B) runs on CPU via KServe -- no GPU needed.

Both GPU deployments use `nodeSelector: nvidia.com/gpu.product: NVIDIA-L40S` so they schedule on the same node and each gets one GPU.

## Model Architecture

- **Supervisor, Planner, and Critic**: One Qwen3-8B FP8-dynamic instance, three logical roles. Different `ChatOpenAI` instances with role-specific prompts, temperature, and `max_completion_tokens`. Two K8s Services route to the same pod (`synesis-supervisor` and `synesis-critic`).
- **Executor**: DeepSeek R1-Distill-Qwen-32B FP8-dynamic. Separate deployment with FP8 KV cache (`--kv-cache-dtype=fp8_e5m2`). Always produces `<think>...</think>` reasoning before content.
- **Summarizer**: Qwen2.5-0.5B on CPU (KServe InferenceService). Used for pivot history summarization.

## Flexible Scaling

| Topology        | GPUs | Use case                          |
|-----------------|------|-----------------------------------|
| 2x L40S (now)  | 2    | G6e.4xlarge; default              |
| 4x L40S        | 4    | Scale executor replicas or split workloads |

Adjust `nodeSelector`, `replicas`, and `resources` in `base/model-serving/deployment-vllm-*.yaml` as needed.

## Deployment Flow

1. **Bootstrap pipelines**: `./scripts/bootstrap-pipelines.sh` -- PVCs, hf-hub-secret
2. **Run pipelines**: `./scripts/run-model-pipeline.sh --profile=small` (or `--role=router`, `--role=coder`, etc.)
3. **Deploy**: `./scripts/deploy.sh dev` -- applies model deployments + planner + gateway

Verify:

```bash
oc get pods -n synesis-models
oc get deployment synesis-supervisor-critic synesis-executor -n synesis-models
```

## UDS (low-latency, no OVN)

Planner and models co-locate on the same node. Planner can use Unix domain sockets instead of HTTP to talk to vLLM, avoiding cluster network traffic. See [UDS_SETUP.md](UDS_SETUP.md).

## Related

- [base/model-serving/README.md](../base/model-serving/README.md)
- [models.yaml](../models.yaml) -- single source of truth for deployed models
- [UDS_SETUP.md](UDS_SETUP.md) -- UDS wiring and hostPath SCC
- [pipelines/README.md](../pipelines/README.md)
