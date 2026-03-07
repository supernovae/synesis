# GPU Topology

How Synesis model serving uses GPU nodes for router, general, critic, and coder.

## Current: 3x L40S (3x g6e.2xlarge)

**Three GPU instances** with 1x L40S each (48GB each, 144GB total). One deployment per GPU:

| Deployment      | Model                                    | Roles                              | GPU | Notes                                   |
|----------------|------------------------------------------|-------------------------------------|-----|-----------------------------------------|
| synesis-router | Qwen3-8B FP8-dynamic                     | Router, Planner, Advisor, Critic   | 0   | Shared model; thinking mode for critic  |
| synesis-general| Qwen3-32B FP8-dynamic                    | General, Writer                    | 1   | Dedicated worker/response generation    |
| synesis-coder  | Qwen3-Coder-30B-A3B FP8                  | Coder                              | 2   | Direct IDE endpoint                     |

Summarizer (Qwen2.5-0.5B) runs on CPU via KServe -- no GPU needed.

All GPU deployments use `nodeSelector: node-role.autonode/gpu: ""` to target Karpenter's GPU node pool.

## Model Architecture

- **Router** (synesis-router): One Qwen3-8B FP8-dynamic instance, multiple logical roles. Different `ChatOpenAI` instances with role-specific prompts, temperature, and `max_completion_tokens`. In small profile, also serves the critic role via `--served-model-name=synesis-router,synesis-critic`. The `synesis-critic` Service selector is patched to target the router pod.
- **General** (synesis-general): Qwen3.5-35B-A3B FP8 MoE. Dedicated worker/writer model for response generation.
- **Critic** (synesis-critic): DeepSeek R1-Distill-Qwen-32B FP8-dynamic. Scaled to 0 in small profile. Medium/large profiles use the dedicated R1 deployment. FP8 KV cache (`--kv-cache-dtype=fp8_e4m3`). Always produces `<think>...</think>` reasoning before content.
- **Summarizer**: Qwen2.5-0.5B on CPU (KServe InferenceService). Used for pivot history summarization.

## Flexible Scaling

| Topology         | GPUs | Use case                                   |
|-----------------|------|--------------------------------------------|
| 3x L40S (now)   | 3    | 3x g6e.2xlarge; small profile              |
| 4x L40S         | 4    | Medium; all roles dedicated                 |
| 8x GPU          | 8    | Large; HPA auto-scaling for coder           |

Adjust `nodeSelector`, `replicas`, and `resources` in `base/model-serving/deployment-vllm-*.yaml` as needed.

## Deployment Flow

1. **Bootstrap pipelines**: `./scripts/bootstrap-pipelines.sh` -- PVCs, hf-hub-secret
2. **Run pipelines**: `./scripts/run-model-pipeline.sh --profile=small` (or `--role=router`, `--role=coder`, etc.)
3. **Deploy**: `./scripts/deploy.sh dev` -- applies model deployments + planner + gateway

Verify:

```bash
oc get pods -n synesis-models
oc get deployment synesis-router synesis-general synesis-coder -n synesis-models
```

## UDS (low-latency, no OVN)

Planner and models co-locate on the same node. Planner can use Unix domain sockets instead of HTTP to talk to vLLM, avoiding cluster network traffic. See [UDS_SETUP.md](UDS_SETUP.md).

## Related

- [base/model-serving/README.md](../base/model-serving/README.md)
- [models.yaml](../models.yaml) -- single source of truth for deployed models
- [UDS_SETUP.md](UDS_SETUP.md) -- UDS wiring and hostPath SCC
- [pipelines/README.md](../pipelines/README.md)
