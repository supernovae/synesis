# Model compatibility and serving optimizations

Synesis provides a common API and tool-validation layer while preserving model-specific reasoning protocols. It does not implement attention kernels, learned memory, or speculative decoding. This guide records the compatibility behavior we maintain and the serving options operators can evaluate. Architecture is an efficiency design choice, not a reliability rating.

Primary sources last reviewed: **2026-09-09**. A model-family match selects compatibility behavior; it does not certify an endpoint, hardware configuration, or task-success rate.

## Shared contract

- Resolve cards by exact model, then longest model-name match, then family. Shared providers such as vLLM and OpenRouter do not identify a model family.
- Preserve assistant reasoning and tool-call parts for supported reasoning adapters, including streamed and non-streamed `reasoning_content`. Clients must replay required history; Synesis cannot reconstruct omitted reasoning.
- Preserve native tool schemas and caller reasoning choices. Validate arguments; repair only an unambiguous known command alias. Repeated successful reads or planning are not failure evidence.
- Compare complete, byte-identical output for deduplication. Protect the latest detected verification failure across model families; compaction instructions retain current failure evidence and exact paths.
- Use configured context, reduction and checkpoint limits. Model names do not silently increase retention, reduce context capacity, or enable extra inference passes. Explicit measured architecture overrides remain available.

These controls normalize transport and tool handling without promising identical model capabilities. See [architecture controls](model-architecture-awareness.md), [compaction policy](coder/COMPACTION_SENSITIVITY.md), and [harness compatibility](clients/HARNESS_COMPATIBILITY.md) for their separate boundaries.

## Model cards

“Reasoning replay” below means the compatible SDK transport preserves assistant reasoning on supported wire paths. It does not mean every hosted endpoint exposes the same extensions or every client returns them.

| Model / family | Synesis compatibility behavior | Deployment considerations and primary sources |
| --- | --- | --- |
| **Qwen3.8-27B** | Common Qwen reasoning card; reasoning replay; no unconditional sampling override or context discount. | Dense activation with Gated DeltaNet/gated-attention layers and MTP training. Thinking is enabled by default; mode-specific sampling belongs to deployment configuration. [Model card](https://huggingface.co/Qwen/Qwen3.8-27B), [vLLM recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-27B). |
| **Qwen3.8-Flash-Next** | Same reasoning transport as general Qwen, with distinct architectural metadata. It does not select the non-thinking Qwen3-Coder-Next card. | MoE backbone combines Gated DeltaNet, Qwen Sparse Attention and learned n-gram embeddings. Offload and parser requirements differ from 27B; see below. [Model card](https://huggingface.co/Qwen/Qwen3.8-Flash-Next), [architecture paper](https://arxiv.org/abs/2608.30320). |
| **DeepSeek V4** | Reasoning replay; on the official DeepSeek API, translate `enable_thinking` to `thinking.type`. Accept extended reasoning-effort values. | Thinking tool continuations require prior assistant reasoning. Endpoint rules determine accepted effort values and sampling behavior. V4's CSA/HCA design is distinct from earlier MLA/DSA variants. [Thinking protocol](https://api-docs.deepseek.com/guides/thinking_mode/), [V4 Pro card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro). |
| **GLM-5** | Dedicated GLM card and reasoning-compatible transport; no inferred recall penalty. | DSA is an architectural efficiency mechanism. Configure the endpoint's GLM template/parser. [Card](https://huggingface.co/zai-org/GLM-5), [technical report](https://arxiv.org/abs/2602.15763). |
| **Kimi K2 / K2.5** | Reasoning replay; no unconditional family temperature. Kimi Coding requests identify Synesis honestly. | Thinking and instant modes have different sampling recommendations; subscription access remains provider-specific. [K2.5 card](https://huggingface.co/moonshotai/Kimi-K2.5). |
| **MiniMax M2 / M2.5** | Preserve interleaved reasoning; use configured retention and checkpoint limits. | No family-level assumption about speculative decoding or special compaction tolerance. [M2](https://huggingface.co/MiniMaxAI/MiniMax-M2), [M2.5](https://huggingface.co/MiniMaxAI/MiniMax-M2.5). |
| **Xiaomi MiMo** | Dedicated family resolution, reasoning replay and native tool validation. | Match capabilities to the exact checkpoint and endpoint; branding alone does not establish recall or serving performance. [V2.5 Pro card](https://huggingface.co/XiaomiMiMo/MiMo-V2.5-Pro). |
| **Other / opaque models** | Generic compatible transport and common validation; explicit family configuration can select a known adapter. | Unknown architectural and quality traits remain unknown. Reasoning extensions, vision, structured output and tool parsing require endpoint-specific validation. |

### Older deployments we still accommodate

Compatibility is retained where it has a concrete protocol or sampling purpose, rather than treating older checkpoints as the baseline for modern models.

| Model | Maintained distinction |
| --- | --- |
| Qwen3-Coder original / Qwen3-Coder-Next | Separate sampling defaults: temperature 0.7 / 1.0 respectively, both top-p 0.95. Original defaults are not inherited by general Qwen reasoning models. Next is non-thinking. [Original card](https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct), [Next card](https://huggingface.co/Qwen/Qwen3-Coder-Next). |
| Qwen3.5 / Qwen3.6 | Common Qwen reasoning transport; hybrid linear/full attention does not impose a context discount. Historical thinking preservation depends on the template. [3.5 card](https://huggingface.co/Qwen/Qwen3.5-397B-A17B), [3.6 card](https://huggingface.co/Qwen/Qwen3.6-35B-A3B). |
| DeepSeek V3 / R1 / V3.2 | Preserve reasoning compatibility while distinguishing original MLA models from V3.2 DSA. Distilled checkpoints do not inherit the teacher's architecture. [V3 card](https://huggingface.co/deepseek-ai/DeepSeek-V3), [V3.2 card](https://huggingface.co/deepseek-ai/DeepSeek-V3.2). |

## Running Qwen3.8

Qwen3.8 variants share a family name but need different serving configurations. The following are upstream settings, not extra fields accepted by the Synesis chat API. Pin and validate the runtime, model revision and template together.

| Setting | Qwen3.8-27B | Qwen3.8-Flash-Next |
| --- | --- | --- |
| vLLM reasoning parser | `qwen3` | `qwen3` |
| vLLM tool parser | `qwen3_coder` | `qwen3_xml` |
| Automatic tool selection | `--enable-auto-tool-choice` | `--enable-auto-tool-choice` |
| Runtime selection | Follow the current 27B recipe for the chosen hardware and precision. | The reviewed recipe requires the dedicated `vllm/vllm-openai:qwen38-flash-next` image; it does not claim current PyPI support. Pin a tested image digest. |
| Context | Configure `--max-model-len` within the actual deployment budget. | Same; selective attention's token-selection budget is not the request-context ceiling. |

Sources: [27B serving recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-27B), [Flash-Next serving recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-Flash-Next).

Both cards describe a 262,144-token native window and extension to one million. Configure Synesis' ceiling to the server's actual supported limit, with ordinary output reservation. Raising a proxy limit does not configure the model's positional extension or provision memory. [27B card](https://huggingface.co/Qwen/Qwen3.8-27B), [Flash-Next card](https://huggingface.co/Qwen/Qwen3.8-Flash-Next).

For 27B, thinking and historical thinking preservation default on; the card lists `xhigh`, `medium` and `low` reasoning effort. Lower effort can require more retries, so measure completed-task cost rather than assuming fewer thinking tokens always improve efficiency. The card gives different thinking/non-thinking sampling settings, which is why Synesis does not impose one general Qwen temperature. [27B card](https://huggingface.co/Qwen/Qwen3.8-27B).

Use the actual Qwen model identifier in the backend registry, or an explicit Qwen family hint for opaque aliases. Existing Qwen resolution covers these 3.8 variants. Yarn accepts `reasoning_effort`, but upstream chat-template controls such as `chat_template_kwargs.enable_thinking` and `preserve_thinking` are not arbitrary pass-through fields in its public request schema. Configure those defaults upstream and verify reasoning replay with the actual client. Do not assume a top-k field survives every provider path merely because a model recommends it.

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

Synesis therefore removes unmeasured brand-based context discounts, recall ratings, governor bias and automatic extra passes. Qwen/MiniMax names no longer demote configured reducer profiles, enlarge transcript windows, or delay checkpoints. Common failure-evidence protection replaces family-specific protection. Sampling exceptions remain narrow; reasoning protocols remain explicit. Operators can still apply [measured registry overrides](model-architecture-awareness.md#admin-overrides).

Context management remains a workload question. The recent [KVMem preprint](https://arxiv.org/abs/2609.04852) reports gains over compaction for a Qwen3.8-27B long-context agent using a separate KV-memory system. This is evidence worth evaluating, not proof of an architectural flaw or a replicated Synesis result. We have not added its paging subsystem or claimed those gains here.

A useful shim should preserve a documented protocol requirement or prevent a demonstrated invalid operation. New model-name rules, steering prompts and extra inference passes need a reproducible failure and a comparison showing improved task success without excessive intervention. Models share enough transport conventions to reuse adapters; they still differ enough in reasoning, templates, tool parsing and modality to need this compatibility guide.

## Validation and maintenance

Repository tests cover card precedence, Qwen3.8 family selection, real SDK serialization/parsing against mocked HTTP, reasoning replay, conservative argument repair, failure-only repetition detection, exact output comparisons and common retention behavior. Yarn, Planner and the shared upper harness are checked together because architecture policy is shared. These tests do not certify live provider quality or hardware performance.

Before promoting a deployment, exercise its actual template/parser, thinking modes, multi-turn tool reasoning, structured output, cancellation, usage reporting, long-context retrieval and recovery after compaction. Compare completed-task success, false interventions, tokens per successful task, peak memory, throughput and tail latency against a baseline. Record the model revision, runtime, hardware, client and controls alongside results. Keep overrides only while that evidence supports them.

Update this guide when a maintained compatibility contract or validated serving option changes. Keep implementation history in Git; avoid turning the model cards into an accumulating list of past incidents or unsupported performance promises.
