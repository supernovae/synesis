# vLLM Recipes Reference

When debugging model serving (KServe InferenceService, vLLM args, OOM, tool calling), consult the [vLLM Recipes](https://docs.vllm.ai/projects/recipes/en/latest/) for model-specific configuration.

## Qwen family (Synesis models)

| Model | Recipe | Notes |
|-------|--------|-------|
| Qwen3-Next (80B MoE) | [Qwen3-Next](https://docs.vllm.ai/projects/recipes/en/latest/Qwen/Qwen3-Next.html) | 4× GPU typical; `--tool-call-parser hermes`, `--enable-auto-tool-choice` |
| Qwen3-Coder (480B) | [Qwen3-Coder-480B](https://docs.vllm.ai/projects/recipes/en/latest/Qwen/Qwen3-Coder-480B-A35B.html) | 8× H200; `--tool-call-parser qwen3_coder` |
| **Qwen3-Coder-Next** (80B MoE, 3B active) | Same family as above | 1× 48GB GPU: `--tensor-parallel-size 1`, `--max-model-len 32768`, `--tool-call-parser qwen3_coder` |

## Common args from recipes

- **Single GPU (48GB)**: `--tensor-parallel-size 1`, `--max-model-len 32768`, `--gpu-memory-utilization 0.9`
- **Tool calling (Qwen3-Coder-Next)**: `--enable-auto-tool-choice`, `--tool-call-parser qwen3_coder`
- **MoE / Qwen3-Next**: `--no-enable-prefix-caching` (unsupported)
- **CUDA IMA error**: `--compilation_config.cudagraph_mode=PIECEWISE`

## ServingRuntime location

Executor args live in `base/model-serving/serving-runtime-executor.yaml`. Update the `args` list there when aligning with vLLM recipes.

## GPU scheduling (node selectors)

Models use `nodeSelector` to target specific GPU types (NFD/GFD labels):

| Model | GPU product | Instance type | VRAM |
|-------|-------------|---------------|------|
| Supervisor, Critic | NVIDIA-A10G | g5.xlarge | 24GB |
| Executor | NVIDIA-L40S | g6e.4xlarge | 48GB |

Labels come from NVIDIA GPU Feature Discovery (`nvidia.com/gpu.product`). Verify with `oc describe node <gpu-node> | grep nvidia.com`.
