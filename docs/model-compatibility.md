# Model compatibility and serving optimizations

Synesis supplies local source evidence through MCP. It does not intercept model traffic, select model-family shims, impose sampling settings or manage conversation history. Planner/Yarn and their compatibility adapters have been removed. The client and native endpoint own reasoning, tool calls, modalities, context management and serving.

This guide retains upstream considerations reviewed on **2026-09-09**. They are not a Synesis model support matrix or a recommendation to provision hardware. There is no running Synesis model deployment or live model-quality result. Pin the exact model, runtime, template and client together when evaluating these options.

## Compatibility boundary

The same four knowledge tools serve every compatible MCP client. Model differences still matter at the native endpoint:

| Family | Native behavior to verify | Primary references |
| --- | --- | --- |
| Qwen3.8 | Thinking mode, reasoning replay, template and tool parser differ by variant. See the serving notes below. | [27B card](https://huggingface.co/Qwen/Qwen3.8-27B), [Flash-Next card](https://huggingface.co/Qwen/Qwen3.8-Flash-Next) |
| DeepSeek | Thinking tool continuations and accepted effort/option fields depend on the endpoint. The client must preserve required reasoning history. | [Thinking protocol](https://api-docs.deepseek.com/guides/thinking_mode/), [V4 Pro card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro) |
| GLM | Select the exact checkpoint's chat template and reasoning/tool parser. | [GLM-5 card](https://huggingface.co/zai-org/GLM-5), [technical report](https://arxiv.org/abs/2602.15763) |
| Kimi | Thinking and instant modes have their own settings and endpoint access requirements. | [K2.5 card](https://huggingface.co/moonshotai/Kimi-K2.5) |
| MiniMax | Preserve the endpoint's interleaved reasoning and tool protocol through the native client. | [M2.5 card](https://huggingface.co/MiniMaxAI/MiniMax-M2.5) |
| MiMo and other models | Validate the exact checkpoint, endpoint, modalities and client; a family name cannot establish compatibility. | [MiMo V2.5 Pro card](https://huggingface.co/XiaomiMiMo/MiMo-V2.5-Pro) |

Synesis performs no option translation or reasoning reconstruction for these families. Model capability is separate from [harness integration](clients/HARNESS_COMPATIBILITY.md). There is no legacy adapter registry, context discount, sampling override or second planner to configure.

## Running Qwen3.8

Qwen3.8 variants share a family name but need different serving configurations. The following are upstream settings for the reviewed recipes; Synesis has no chat API. Pin and validate the runtime, model revision and template together.

| Setting | Qwen3.8-27B | Qwen3.8-Flash-Next |
| --- | --- | --- |
| vLLM reasoning parser | `qwen3` | `qwen3` |
| vLLM tool parser | `qwen3_coder` | `qwen3_xml` |
| Automatic tool selection | `--enable-auto-tool-choice` | `--enable-auto-tool-choice` |
| Runtime selection | Follow the current 27B recipe for the chosen hardware and precision. | The reviewed recipe requires the dedicated `vllm/vllm-openai:qwen38-flash-next` image; it does not claim current PyPI support. Pin a tested image digest. |
| Context | Configure `--max-model-len` within the actual deployment budget. | Same; selective attention's token-selection budget is not the request-context ceiling. |

Sources: [27B serving recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-27B), [Flash-Next serving recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-Flash-Next).

Both cards describe a 262,144-token native window and extension to one million. Keep client request budgets within the server's actual supported limit, including output reservation. A configured token limit does not provision memory or enable positional extension. [27B card](https://huggingface.co/Qwen/Qwen3.8-27B), [Flash-Next card](https://huggingface.co/Qwen/Qwen3.8-Flash-Next).

For 27B, thinking and historical thinking preservation default on; the card lists `xhigh`, `medium` and `low` reasoning effort. Lower effort can require more retries, so measure completed-task cost rather than assuming fewer thinking tokens always improve efficiency. The card gives different thinking/non-thinking sampling settings, so use the upstream recommendations for the selected mode. [27B card](https://huggingface.co/Qwen/Qwen3.8-27B).

Use the exact Qwen identifier and reviewed template on the native endpoint. Verify that the actual client preserves required reasoning and accepts the chosen template options. Synesis has no model registry or chat-template pass-through; a recommended sampling field must be supported by the client/provider path that sends it.

### What learned n-grams enable

Flash-Next adds learned bigram/trigram embedding tables to its MoE backbone. The architecture paper describes host-memory prefetch for this added capacity and evaluates accuracy, compute cost and training stability together. This is trained model memory, distinct from prompt-lookup speculative decoding and from MTP. A proxy-side n-gram prompt or fuzzy transcript deduplicator would not reproduce it. [Qwen3.8-Next architecture paper](https://arxiv.org/abs/2608.30320).

The Flash-Next recipe exposes `VLLM_PLE_CPU_OFFLOAD=1` for embedding-table offload/prefetch, requiring at least 51 GB host RAM plus headroom. Check its NVIDIA and parallelism restrictions; active backbone parameters alone do not establish hardware fit. [Flash-Next serving recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-Flash-Next).

### Other architecture opportunities

- **Hybrid attention:** Gated DeltaNet combines gating with delta-rule state updates; hybrids trade compute and memory differently from all-full-attention models. Use optimized runtime kernels and measure retrieval on the deployment workload. [Gated Delta Networks paper](https://arxiv.org/abs/2412.06464).
- **Selective attention:** Flash-Next combines Gated DeltaNet with Qwen Sparse Attention. Evaluate prefill/decode efficiency and task quality together; sparse attention does not imply the proxy should remove history. [Architecture paper](https://arxiv.org/abs/2608.30320).
- **MTP and speculative decoding:** Treat these as runtime experiments. The Flash-Next recipe reports MTP throughput regressions on tested H100 configurations; training with an MTP head is not a universal deployment recommendation. [Flash-Next recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-Flash-Next). Prompt-lookup n-gram speculation is a separate serving technique. [vLLM speculative decoding](https://docs.vllm.ai/en/latest/features/speculative_decoding/).
- **Prefix reuse:** Stable prompts offer upstream prefix-caching opportunities; cache hits depend on the runtime and workload. [Flash-Next recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-Flash-Next).
- **Extended context:** The recipe's YaRN RoPE scaling is a model-serving technique, distinct from the Synesis Yarn proxy. Evaluate both short and long inputs before increasing the configured ceiling. [Flash-Next recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-Flash-Next).

The [Qwen3 technical report](https://arxiv.org/abs/2505.09388) documents the earlier family's dense/MoE and reasoning lineage; the [Qwen3.8-Next paper](https://arxiv.org/abs/2608.30320) is the relevant reference for Flash-Next's n-gram and sparse-attention design. Do not transfer every architectural claim between variants.

## Assumptions we have retired

There is no adequate basis for assigning poor long-horizon reliability from sparse attention, MLA, hybrid attention or MoE branding alone. Modern training and serving behavior need versioned evaluation. The Qwen3.8-27B card reports improved agent benchmarks, but those vendor results do not establish that long-horizon failures have disappeared across deployments. [27B card](https://huggingface.co/Qwen/Qwen3.8-27B).

Synesis has removed its interception layer altogether: model-name context discounts, governor bias, compaction policy, steering prompts and extra inference passes do not run in the knowledge reader. Source retrieval remains explicit and bounded; conversation retention is client-owned.

Context management remains a workload question. The recent [KVMem preprint](https://arxiv.org/abs/2609.04852) reports gains over compaction for a Qwen3.8-27B long-context agent using a separate KV-memory system. This is evidence worth evaluating, not proof of an architectural flaw or a replicated Synesis result. We have not added its paging subsystem or claimed those gains here.

## Validation and maintenance

Repository checks exercise source integrity, bounded versioned evidence, local SQLite and the MCP transport. The removed proxy's model-card, reasoning-replay and compaction tests are no longer presented as coverage of this product. Live model quality and hardware performance remain unverified.

For an endpoint you actually need, test its template/parser, thinking modes, multi-turn tool reasoning, structured output, cancellation and recovery with your native client. Measure completed-task success and total work cost, including retries. Record the model revision, runtime, hardware and client alongside any results.

The source reader is model-independent at its own boundary; models are not assumed to have identical capabilities. Keep a separate behavior workaround only for a documented protocol requirement or reproducible current failure, preferably in the client or upstream implementation that owns it.
