# vLLM Recipes Reference

When debugging model serving (KServe InferenceService, vLLM args, OOM, tool calling), consult the [vLLM Recipes](https://docs.vllm.ai/projects/recipes/en/latest/) for model-specific configuration.

## Qwen family (Synesis models)

| Model | Recipe | Notes |
|-------|--------|-------|
| Qwen3-Next (80B MoE) | [Qwen3-Next](https://docs.vllm.ai/projects/recipes/en/latest/Qwen/Qwen3-Next.html) | 4× GPU typical; `--tool-call-parser hermes`, `--enable-auto-tool-choice` |
| Qwen3-Coder (480B) | [Qwen3-Coder-480B](https://docs.vllm.ai/projects/recipes/en/latest/Qwen/Qwen3-Coder-480B-A35B.html) | 8× H200; `--tool-call-parser qwen3_coder` |
| **Qwen3-Coder-30B-A3B-Instruct-FP8** (30B MoE) | [Qwen3-Coder-30B-FP8](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8) | 1× 48GB GPU; ~30GB VRAM; `--tool-call-parser qwen3_coder`. BF16 OOMs on 48GB. |
| Qwen3-Coder-Next-FP8 (80B MoE) | [Qwen3-Coder-Next-FP8](https://huggingface.co/Qwen/Qwen3-Coder-Next-FP8) | Requires 2× 48GB or 1× 80GB; vLLM 0.15.0+; not suitable for single L40S. |

## Common args from recipes

- **Single GPU (48GB)**: `--tensor-parallel-size 1`, `--max-model-len 32768`, `--gpu-memory-utilization 0.9`
- **Tool calling (Qwen3-Coder-Next)**: `--enable-auto-tool-choice`, `--tool-call-parser qwen3_coder`
- **MoE / Qwen3-Next**: `--no-enable-prefix-caching` (unsupported)
- **CUDA IMA error**: `--compilation_config.cudagraph_mode=PIECEWISE`

## ServingRuntime location

Executor args live in `base/model-serving/serving-runtime-executor.yaml`. Update the `args` list there when aligning with vLLM recipes.

## Executor on 48GB

`Qwen/Qwen3-Coder-Next-FP8` (80B MoE) requires ~85GB VRAM—too large for a single L40S (48GB). Use `Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8`: 30B MoE, ~30GB VRAM, tool calling, fits on 48GB. BF16 variant OOMs.

## Deployment strategy (Recreate vs RollingUpdate)

RHOAI 3 can trigger rolling restarts on `oc apply` even when the spec is unchanged (metadata/resourceVersion churn). With `RollingUpdate`, that requires N+1 GPU capacity during rollout. We use `deploymentStrategy: Recreate` so the old pod terminates before the new one starts—no extra GPU headroom needed.

## OpenShift AI vLLM versions

RHOAI ships `registry.redhat.io/rhaiis/vllm-cuda-rhel9` with **vLLM 0.11.x** (RHAIIS 3.2.x). There is no official Red Hat image with vLLM 0.15+. If you need a newer vLLM (e.g. for FP8 MoE fixes), you can use a custom ServingRuntime image—see [Red Hat solution 7127194](https://access.redhat.com/solutions/7127194). Override the `image` field in the ServingRuntime container spec.

## GPU scheduling (node selectors)

Models use `nodeSelector` to target specific GPU types (NFD/GFD labels):

| Model | GPU product | Instance type | VRAM |
|-------|-------------|---------------|------|
| Supervisor, Critic | NVIDIA-A10G | g5.xlarge | 24GB |
| Executor | NVIDIA-L40S | g6e.4xlarge | 48GB |

Labels come from NVIDIA GPU Feature Discovery (`nvidia.com/gpu.product`). Verify with `oc describe node <gpu-node> | grep nvidia.com`.
