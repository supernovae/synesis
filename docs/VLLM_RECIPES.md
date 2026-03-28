# vLLM Recipes Reference

When debugging model serving (Deployments, vLLM args, OOM), consult the [vLLM Recipes](https://docs.vllm.ai/projects/recipes/en/latest/) and [vLLM Quantization Docs](https://docs.vllm.ai/en/stable/features/quantization/) for model-specific configuration.

## Deployed Models

| Model | Role | Quantization | VRAM | Deployment |
|-------|------|-------------|------|------------|
| **Qwen2.5-14B-Instruct** | Router, Planner, Critic | FP8 (on-the-fly via `--quantization=fp8`) | ~14 GB | `deployment-vllm-router.yaml` |
| **Qwen3-32B FP8-dynamic** | General, Writer | FP8 (dynamic quant) | ~32 GB | `deployment-vllm-general.yaml` |
| **Qwen3-Coder-30B-A3B-FP8** | Coder (small) | FP8 (pre-quantized) | ~15 GB | `deployment-vllm-coder.yaml` |
| **Qwen3-Coder-Next-FP8** | Coder (medium+) | FP8 (pre-quantized) | ~46 GB | `deployment-vllm-coder.yaml` |
| **DeepSeek R1-Distill-Qwen-32B FP8** | Critic (medium+) | FP8 (llm-compressor) | ~33 GB | `deployment-vllm-critic.yaml` |
| **Qwen2.5-0.5B-Instruct** | Summarizer | none (CPU) | 0 | KServe InferenceService |

See [models.yaml](../models.yaml) for the build-time reference. Runtime model routing is managed through the admin Model Registry and synced to LiteLLM.

## General: Qwen3-32B FP8-dynamic

Key vLLM args (from `base/model-serving/deployment-vllm-general.yaml`):

```
--max-model-len=16384
--max-num-seqs=64
--gpu-memory-utilization=0.95
--kv-cache-dtype=fp8_e4m3
--enable-prefix-caching
--enable-chunked-prefill
```

- **Architecture**: Dense 32B transformer. Qwen3 series.
- **FP8 weights ~32GB** — fits on a single L40S with careful memory budgeting.
- **Dense model trade-off**: Unlike the MoE variant, every parameter is active on every token. This gives higher quality per-param but limits throughput to ~20-25 tok/s on a single L40S.
- **Executor role**: Generates responses for Open WebUI users and the planner executor node.
- **Prefix caching**: Enabled — caches system prompts and repeated context across concurrent users.
- **FP8 KV cache**: `--kv-cache-dtype=fp8_e4m3` halves KV memory, allowing 16K context to fit alongside the 32GB model.
- **No thinking flags**: The general deployment does not enable `--enable-reasoning`. Executor explicitly disables Qwen3's default thinking mode via `chat_template_kwargs: {"enable_thinking": false}`.
- **Speculative decoding (future)**: The 8B draft model won't fit alongside the 32B on one GPU. However, ngram-based speculation (`--speculative-model=[ngram] --num-speculative-tokens=5 --ngram-prompt-lookup-max=4`) requires zero extra VRAM and can improve throughput 1.3-1.8x for predictable content.

### General VRAM budget (small profile, single L40S)

| Component | Estimate |
|-----------|----------|
| FP8 weights (32B dense) | ~32 GB |
| FP8 KV cache (16K ctx) | ~4.2 GB |
| CUDA graphs + activation | ~2.5 GB |
| **Total** | **~38.7 GB** |
| L40S usable (0.95 util) | 42.3 GB |

Tight. If OOM occurs, reduce `--max-num-seqs` to 32 or `--max-model-len` to 8192.

## Coder: Profile-Dependent Model

### Small profile: Qwen3-Coder-30B-A3B-Instruct-FP8

Key vLLM args (from `base/model-serving/deployment-vllm-coder.yaml`):

```
--max-model-len=65536
--gpu-memory-utilization=0.90
--enable-auto-tool-choice
--tool-call-parser=hermes          # ⚠ MIGRATE to qwen3_coder — see "XML Tool Calling" section below
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
--tool-call-parser=hermes          # ⚠ MIGRATE to qwen3_coder — see "XML Tool Calling" section below
```

- **Architecture**: 80B MoE with 512 experts, 10 active per token (~3B active). Hybrid attention (gated attention + DeltaNet).
- **FP8 weights ~46GB** — requires TP=2 (2 GPUs). Will OOM on any single GPU.
- **Why not single-GPU?**: All 512 expert weight tensors must reside in VRAM even though only 10 are active per token. FP8 compresses from ~80GB to ~46GB but that still exceeds any single 48GB card.

## Critic: DeepSeek R1-Distill-Qwen-32B FP8

Key vLLM args (from `base/model-serving/deployment-vllm-critic.yaml`):

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

## Router + Critic (small profile): Qwen2.5-14B-Instruct FP8

Key vLLM args (from `base/model-serving/deployment-vllm-router.yaml`):

```
--served-model-name=synesis-router,synesis-critic
--quantization=fp8
--generation-config=vllm
--enable-prefix-caching
--enable-chunked-prefill
--max-model-len=32768
--gpu-memory-utilization=0.90
```

- **On-the-fly FP8**: `--quantization=fp8` applies dynamic FP8 quantization at load time. No pre-quantized HuggingFace variant needed — uses the original `Qwen/Qwen2.5-14B-Instruct` weights. Native Ada Lovelace tensor core ops on L40S.
- **Prefix caching**: Enabled. Caches KV states for repeated system prompts across router/planner/critic roles.
- **Chunked prefill**: Improves TTFT by overlapping prefill with decode. Compatible with prefix caching on Qwen2.5.
- **Dual model names**: Serves as both `synesis-router` and `synesis-critic`. In small profile, the `synesis-critic` Service selector is patched to target the router pod.
- **No thinking mode**: Qwen2.5 does not have Qwen3's native `<think>` tag system. The critic uses prompt-based chain-of-thought reasoning via its detailed system prompt. No `--reasoning-parser` flag needed.
- **Why 14B over 8B**: Qwen2.5-14B-Instruct has nearly double the parameter count of Qwen3-8B, providing stronger instruction-following, more definitive evaluations (less "people-pleasing"), and better task decomposition. The extra capacity eliminates the need for model-native thinking mode — the 14B model can reason effectively in a single forward pass.
- **Small profile GPU savings**: Eliminates the need for a separate R1 deployment. One 14B model on one GPU handles routing, planning, advising, and critiquing. Medium/large profiles deploy dedicated R1 for even stronger critic reasoning.

### VRAM budget (single L40S)

| Component | Estimate |
|-----------|----------|
| FP8 weights (14B dense) | ~14 GB |
| KV cache (32K ctx, FP16) | ~5.5 GB |
| CUDA graphs + activation | ~2.5 GB |
| **Total** | **~22 GB** |
| L40S usable (0.90 util) | ~43 GB |

Substantial headroom (~21 GB free). Could increase `--max-model-len` to 65536 or raise `--max-num-seqs` for higher concurrency if needed.

## Qwen3-Coder: XML Tool Calling (qwen3\_coder parser)

**Status**: Ready to deploy on vLLM. This is the highest-priority upgrade for
Yarn/IDE tool-call reliability.

### Why this matters

The Qwen3-Coder model family was explicitly trained with an **XML tool calling
format** (`qwen3_coder`) designed for string-heavy arguments — the model can emit
multi-line code blocks inside `<parameter>` tags without JSON escaping. The
[Qwen3-Coder-Next technical report](https://arxiv.org/html/2603.00729v1) (§4.2.2)
states:

> "JSON is a widely used protocol, it often introduces heavy escaping overhead for
> multi-line code. To address this, we also introduce an XML-style tool calling
> format, `qwen3_coder`, which is designed for string-heavy arguments and allows
> the model to emit long code snippets without nested quoting."

When we route through providers that force JSON tool calling (e.g., DeepInfra),
the model struggles to serialize code containing quotes and newlines into JSON
string values. This causes garbled Write tool calls, wasted tokens on retries,
and files that never get saved. Our Yarn adapter layer (`repairWriteToolCall`,
`remapToolArgs`, Bash heredoc prompt steering) mitigates this but is a workaround,
not a fix.

### vLLM deployment flags

Replace `--tool-call-parser=hermes` with:

```
--enable-auto-tool-choice
--tool-call-parser=qwen3_coder
```

vLLM has the `Qwen3CoderToolParser` merged since [PR #25028](https://github.com/vllm-project/vllm/pull/25028)
(Sep 2025). The Qwen team also provides an updated parser + template via their
[HF repo](https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct/discussions/27).
To use the latest version before vLLM upstream catches up:

```
--enable-auto-tool-choice \
--tool-call-parser=qwen3_coder \
--tool-parser-plugin="/path/to/qwen3coder_tool_parser.py" \
--chat-template="/path/to/chat_template.jinja"
```

Download both files from the HF model repo's root directory.

### What the XML format looks like

Tool definitions are rendered as XML in the system message:

```xml
<tools>
  <tool>
    <name>Write</name>
    <description>Write content to a file</description>
    <parameters>
      <parameter>
        <name>file_path</name>
        <type>string</type>
      </parameter>
      <parameter>
        <name>content</name>
        <type>string</type>
      </parameter>
    </parameters>
  </tool>
</tools>
```

The model calls tools using XML tags — code content goes between parameter tags
with **no JSON escaping**:

```xml
<tool_call>
  <name>Write</name>
  <file_path>hello.go</file_path>
  <content>
package main

import "fmt"

func main() {
	fmt.Println("Hello, World!")
}
  </content>
</tool_call>
```

vLLM's `qwen3_coder` parser converts this to OpenAI-compatible JSON tool call
responses on the API boundary, so downstream clients (Claude Code, Cursor, etc.)
see standard `tool_calls` objects.

### Provider compatibility matrix

| Provider | XML tool format | Notes |
|---|---|---|
| **vLLM (self-hosted)** | Supported | `--tool-call-parser=qwen3_coder`. Proper fix. |
| **DashScope (Alibaba)** | Server-side | OpenAI-compatible JSON API, but XML→JSON conversion done server-side. Tool calls come through clean. US endpoint: `dashscope-us.aliyuncs.com`. |
| **DeepInfra** | Not supported | JSON-only OpenAI shim. Use Yarn adapter workarounds. |
| **OpenRouter** | Varies by backend | Routes to multiple providers. Pin to Alibaba via `provider.only`. |
| **Together AI** | Unknown | Lists `toolCalling: true` on HF. Untested with XML template. |
| **Novita** | Unknown | Lists `toolCalling: true` on HF. Untested with XML template. |
| **Hyperbolic** | Unknown | Lists `toolCalling: true` on HF. Untested with XML template. |

### DashScope direct (Alibaba)

DashScope is Alibaba's own model serving platform. They handle XML tool call
parsing server-side, so the OpenAI-compatible API returns clean JSON `tool_calls`
even for code-heavy arguments. No Yarn-side workarounds needed.

**Endpoints** (OpenAI-compatible):

| Region | Base URL | Env var |
|---|---|---|
| Singapore (intl) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` |
| US (Virginia) | `https://dashscope-us.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` |
| China (Beijing) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` |

**Available models**: `qwen3-coder-next` (OSS, 80B MoE), `qwen3-coder-plus`
(proprietary, 1M context). Both available in all regions.

**Setup in admin**: Select provider `Alibaba DashScope` or `Alibaba DashScope (US)`
in the Model Registry for any coder role. Set `DASHSCOPE_API_KEY` env var.

**Yarn adapter behavior**: When `resolveAdapter` detects a `dashscope` URL,
`Qwen3CoderAdapter` sets `nativeToolParser=true`, which:
- Uses a minimal tool system prompt (no Bash heredoc workaround)
- `remapToolArgs` and `repairWriteToolCall` remain as safety nets but should
  rarely trigger since DashScope returns correctly structured tool calls

### Yarn adapter behavior with vs. without XML

| Layer | With XML parser (vLLM) | Without (DeepInfra/JSON) |
|---|---|---|
| `toolSystemPrompt` | Minimal — model follows native format | Steers model to use Bash heredoc for code |
| `remapToolArgs` | Rarely needed — XML template has correct names | Active — fixes `path` → `file_path` etc. |
| `repairWriteToolCall` | Should never trigger | Safety net for garbled Write content |
| `normalizeToolCallArgs` | Passthrough | Fixes empty/null args |

### Migration checklist

- [ ] Update `base/model-serving/deployment-vllm-coder.yaml`: change
  `--tool-call-parser=hermes` to `--tool-call-parser=qwen3_coder`
- [ ] Download `qwen3coder_tool_parser.py` and `chat_template.jinja` from
  the [HF repo](https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct)
  if using the newer parser (optional — built-in parser works)
- [ ] Test with Claude Code: Write tool calls with code content containing
  quotes and newlines should now succeed without the Bash heredoc fallback
- [ ] Verify `repairWriteToolCall` stops triggering (check for absence of
  `write_tool_repaired_to_bash_heredoc` log events)
- [ ] Consider adding `--chat-template` flag if the built-in template lags
  the HF repo version
- [ ] Update `Qwen3CoderAdapter.toolSystemPrompt()` to return `undefined`
  when the backend is vLLM with XML parser (adapter can check `baseUrl`)

## Common Troubleshooting

| Issue | Fix |
|-------|-----|
| OOM on startup | Reduce `--max-model-len` or `--gpu-memory-utilization` |
| 404 on `/v1/health` | Health endpoint is at `/health` (no `/v1` prefix) |
| Slow TTFT | Enable `--enable-chunked-prefill`; check `--gpu-memory-utilization` |
| No reasoning content (R1) | Ensure `--reasoning-parser=deepseek_r1` for R1-Distill models |
| No reasoning content (Qwen3 general) | Ensure `--enable-reasoning --reasoning-parser=qwen3` on the general model |
| FP8 KV cache + prefix caching | These are mutually exclusive in current vLLM. Choose one. |
| Router returning `<think>` tags | Router uses Qwen2.5-14B (no native thinking). Remove `--reasoning-parser` if present. |

## Deployment strategy (Recreate vs RollingUpdate)

GPU deployments use `strategy: Recreate` so the old pod terminates before the new one starts -- no extra GPU headroom needed during rollout.

## OpenShift AI vLLM versions

RHOAI ships `registry.redhat.io/rhaiis/vllm-cuda-rhel9`. Both deployments pin the same image digest for consistency. If you need a newer vLLM, override the `image` field in the container spec.

## GPU scheduling (node selectors)

Both model deployments target GPU nodes via Karpenter:

```yaml
nodeSelector:
  node-role.autonode/gpu: ""
```

This label matches the Karpenter GPU node pool. Verify with `oc get nodes -l node-role.autonode/gpu`.
