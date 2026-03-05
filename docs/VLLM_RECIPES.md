# vLLM Recipes Reference

When debugging model serving (Deployments, vLLM args, OOM), consult the [vLLM Recipes](https://docs.vllm.ai/projects/recipes/en/latest/) and [vLLM Quantization Docs](https://docs.vllm.ai/en/stable/features/quantization/) for model-specific configuration.

## Deployed Models

| Model | Role | Quantization | VRAM | Deployment |
|-------|------|-------------|------|------------|
| **Qwen3-8B FP8-dynamic** | Router, Planner, Critic | FP8 (llm-compressor) | ~8 GB | `deployment-vllm-supervisor-critic.yaml` |
| **Qwen3.5-35B-A3B-FP8** | General, Writer | FP8 (Qwen official) | ~35 GB | `deployment-vllm-general.yaml` |
| **Qwen3-Coder-30B-A3B-FP8** | Coder (small) | FP8 (pre-quantized) | ~15 GB | `deployment-vllm-coder.yaml` |
| **Qwen3-Coder-Next-FP8** | Coder (medium+) | FP8 (pre-quantized) | ~46 GB | `deployment-vllm-coder.yaml` |
| **DeepSeek R1-Distill-Qwen-32B FP8** | Critic (medium+) | FP8 (llm-compressor) | ~33 GB | `deployment-vllm-executor.yaml` |
| **Qwen2.5-0.5B-Instruct** | Summarizer | none (CPU) | 0 | KServe InferenceService |

See [models.yaml](../models.yaml) for the authoritative model registry.

## General: Qwen3.5-35B-A3B FP8

Key vLLM args (from `base/model-serving/deployment-vllm-general.yaml`):

```
--max-model-len=32768
--gpu-memory-utilization=0.92
--enable-prefix-caching
--enable-chunked-prefill
```

- **Architecture**: 35B MoE with 3B active parameters per token. Qwen3.5 series — successor to Qwen3 with improved reasoning.
- **FP8 weights ~35GB** — fits on a single L40S with ~9 GB headroom for KV cache.
- **MoE KV cache efficiency**: Attention layers are sized for 3B active params, so KV cache is small (~2-3 GB at 32K context) despite the 35B total parameter count.
- **Worker role**: Generates responses for Open WebUI users and the planner worker node. Quality upgrade over the 8B router fallback in the previous 2-GPU layout.
- **Prefix caching**: Enabled — caches system prompts and repeated context across concurrent users.
- **No thinking flags**: The general deployment does not enable `--enable-reasoning`. Workers control thinking per-request via `chat_template_kwargs` if needed.

### General VRAM budget (small profile, single L40S)

| Component | Estimate |
|-----------|----------|
| FP8 weights (35B MoE, all experts) | ~35 GB |
| KV cache (32K ctx) | ~3 GB |
| Activation memory | ~1 GB |
| **Total** | **~39 GB** |
| L40S usable (0.92 util) | 44 GB |

Tight but workable. If OOM occurs, reduce `--max-model-len` to 16384 first.

## Coder: Profile-Dependent Model

### Small profile: Qwen3-Coder-30B-A3B-Instruct-FP8

Key vLLM args (from `base/model-serving/deployment-vllm-coder.yaml`):

```
--max-model-len=65536
--gpu-memory-utilization=0.90
--enable-auto-tool-choice
--tool-call-parser=hermes
--enable-prefix-caching
--enable-chunked-prefill
```

- **Architecture**: 30B MoE with 3B active parameters per token. Same Qwen3-Coder family as the 80B Next model.
- **FP8 weights ~15GB** — fits easily on a single L40S with full 65K context and ~25GB headroom.
- **Prefix caching**: Enabled — caches repeated system prompts from IDE clients.
- **Separate endpoint**: IDEs (Cursor, Claude Code) connect directly — not routed through the planner.
- **Upgrade path**: Medium/large profiles use Qwen3-Coder-Next-FP8 (80B, TP=2) for max quality.

#### Coder VRAM budget (small profile, single L40S)

| Component | Estimate |
|-----------|----------|
| FP8 weights (30B MoE) | ~15 GB |
| KV cache (65K ctx) | ~4 GB |
| Activation memory | ~1 GB |
| **Total** | **~20 GB** |
| L40S usable (0.90 util) | 40 GB |

Plenty of headroom. The 30B-A3B model is the right fit for single-GPU deployment.

### Medium/Large profile: Qwen3-Coder-Next-FP8

```
--tensor-parallel-size=2
--max-model-len=65536
--gpu-memory-utilization=0.90
--enable-auto-tool-choice
--tool-call-parser=hermes
```

- **Architecture**: 80B MoE with 512 experts, 10 active per token (~3B active). Hybrid attention (gated attention + DeltaNet).
- **FP8 weights ~46GB** — requires TP=2 (2 GPUs). Will OOM on any single GPU.
- **Why not single-GPU?**: All 512 expert weight tensors must reside in VRAM even though only 10 are active per token. FP8 compresses from ~80GB to ~46GB but that still exceeds any single 48GB card.

## Critic: DeepSeek R1-Distill-Qwen-32B FP8

Key vLLM args (from `base/model-serving/deployment-vllm-executor.yaml`):

```
--quantization=fp8
--kv-cache-dtype=fp8_e5m2
--max-model-len=20480
--gpu-memory-utilization=0.92
--enable-chunked-prefill
--reasoning-parser=deepseek_r1
--trust-remote-code
```

- **FP8 quantization**: Native Ada Lovelace tensor core ops on L40S (SM89). No dequantization overhead vs GPTQ-INT4.
- **FP8 KV cache**: `--kv-cache-dtype=fp8_e5m2` halves KV memory footprint. Incompatible with `--enable-prefix-caching` (mutually exclusive in current vLLM).
- **Reasoning parser**: `--reasoning-parser=deepseek_r1` enables vLLM to parse `<think>...</think>` tags into `reasoning_content`.
- **Chunked prefill**: Improves TTFT by overlapping prefill with decode.
- **Memory**: ~33GB weights + ~2.5GB FP8 KV cache (20K ctx) + ~3GB overhead = ~38.5GB of 44GB usable (0.92 util).

## Router + Critic (small profile): Qwen3-8B FP8-dynamic

Key vLLM args (from `base/model-serving/deployment-vllm-supervisor-critic.yaml`):

```
--served-model-name=synesis-supervisor,synesis-critic
--generation-config=vllm
--enable-prefix-caching
--max-model-len=32768
--gpu-memory-utilization=0.90
--enable-reasoning
--reasoning-parser=qwen3
```

- **No `--quantization` flag**: vLLM auto-detects compressed-tensors FP8 format from the model's `config.json`. Native FP8 tensor core ops on L40S.
- **Prefix caching**: Enabled. Caches KV states for repeated system prompts across router/planner/critic roles.
- **Dual model names**: Serves as both `synesis-supervisor` and `synesis-critic`. Two K8s Services route to the same pod.
- **Thinking mode (Qwen3)**: `--enable-reasoning --reasoning-parser=qwen3` separates `<think>` tokens into `reasoning_content`, keeping `content` clean for JSON parsing.
- **Per-request thinking control**: Router/planner/advisor pass `enable_thinking=False` via `chat_template_kwargs` for fast ~100ms classification. Critic passes `enable_thinking=True` for chain-of-thought reasoning.
- **Small profile GPU savings**: Eliminates the need for a separate R1 deployment. One 8B model on one GPU handles both routing and critiquing. Medium/large profiles deploy dedicated R1 for stronger critic reasoning.

### VRAM budget (single L40S)

| Component | Estimate |
|-----------|----------|
| FP8 weights | ~8 GB |
| KV cache (32K ctx) | ~2 GB |
| Overhead | ~1 GB |
| **Total** | **~11 GB** |
| L40S usable (0.90 util) | 40 GB |

Plenty of headroom — the 8B model is very efficient even with thinking enabled.

## Common Troubleshooting

| Issue | Fix |
|-------|-----|
| OOM on startup | Reduce `--max-model-len` or `--gpu-memory-utilization` |
| 404 on `/v1/health` | Health endpoint is at `/health` (no `/v1` prefix) |
| Slow TTFT | Enable `--enable-chunked-prefill`; check `--gpu-memory-utilization` |
| No reasoning content (R1) | Ensure `--reasoning-parser=deepseek_r1` for R1-Distill models |
| No reasoning content (Qwen3) | Ensure `--enable-reasoning --reasoning-parser=qwen3` |
| Router is slow | Check that `enable_thinking=False` is passed in `chat_template_kwargs` |
| FP8 + prefix caching | These are mutually exclusive. Choose one. |
| Critic not using thinking | Verify `enable_thinking=True` in critic node's `extra_body` params |

## Deployment strategy (Recreate vs RollingUpdate)

GPU deployments use `strategy: Recreate` so the old pod terminates before the new one starts -- no extra GPU headroom needed during rollout.

## OpenShift AI vLLM versions

RHOAI ships `registry.redhat.io/rhaiis/vllm-cuda-rhel9`. Both deployments pin the same image digest for consistency. If you need a newer vLLM, override the `image` field in the container spec.

## GPU scheduling (node selectors)

Both model deployments target L40S GPUs:

```yaml
nodeSelector:
  nvidia.com/gpu.product: NVIDIA-L40S
```

Labels come from NVIDIA GPU Feature Discovery (`nvidia.com/gpu.product`). Verify with `oc describe node <gpu-node> | grep nvidia.com`.
