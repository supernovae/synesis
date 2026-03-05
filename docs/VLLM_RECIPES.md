# vLLM Recipes Reference

When debugging model serving (Deployments, vLLM args, OOM), consult the [vLLM Recipes](https://docs.vllm.ai/projects/recipes/en/latest/) and [vLLM Quantization Docs](https://docs.vllm.ai/en/stable/features/quantization/) for model-specific configuration.

## Deployed Models

| Model | Role | Quantization | VRAM | Deployment |
|-------|------|-------------|------|------------|
| **DeepSeek R1-Distill-Qwen-32B FP8-dynamic** | Executor (Worker) | FP8 (llm-compressor) | ~33 GB | `deployment-vllm-executor.yaml` |
| **Qwen3-8B FP8-dynamic** | Supervisor, Planner, Critic | FP8 (llm-compressor) | ~8 GB | `deployment-vllm-supervisor-critic.yaml` |
| **Qwen2.5-0.5B-Instruct** | Summarizer | none (CPU) | 0 | KServe InferenceService |

See [models.yaml](../models.yaml) for the authoritative model registry.

## Executor: DeepSeek R1-Distill-Qwen-32B FP8

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

## Supervisor-Critic: Qwen3-8B FP8-dynamic

Key vLLM args (from `base/model-serving/deployment-vllm-supervisor-critic.yaml`):

```
--generation-config=vllm
--enable-prefix-caching
--max-model-len=32768
--gpu-memory-utilization=0.90
```

- **No `--quantization` flag**: vLLM auto-detects compressed-tensors FP8 format from the model's `config.json`. Native FP8 tensor core ops on L40S.
- **Prefix caching**: Enabled. Caches KV states for repeated system prompts across supervisor/planner/critic roles.
- **Shared deployment**: Two K8s Services route to the same pod for supervisor and critic roles.

## Common Troubleshooting

| Issue | Fix |
|-------|-----|
| OOM on startup | Reduce `--max-model-len` or `--gpu-memory-utilization` |
| 404 on `/v1/health` | Health endpoint is at `/health` (no `/v1` prefix) |
| Slow TTFT | Enable `--enable-chunked-prefill`; check `--gpu-memory-utilization` |
| No reasoning content | Ensure `--reasoning-parser=deepseek_r1` for R1-Distill models |
| FP8 + prefix caching | These are mutually exclusive. Choose one. |

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
