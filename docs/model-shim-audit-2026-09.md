# Model shim audit — September 2026

The audit separates three independent contracts: the model's documented behavior, the endpoint's wire protocol, and the client's tool schema and execution environment. Model architecture alone does not establish a safe context limit, tool reliability, or a need for stronger steering.

## Findings and changes

| Finding | Change | Safety/efficiency effect |
| --- | --- | --- |
| Shared OpenRouter/vLLM provider hints could select the Qwen card for unrelated models. | Exact model matches, then longest model match, then family match; provider fallback must be unique. | Correct sampling and repair policy on shared endpoints. |
| One Qwen Coder shim covered both original Coder and Coder Next. | Separate card/defaults: original temperature 0.7, Next 1.0; both top-p 0.95. General Qwen reasoning models get their own adapter. | Removes outdated sampling and non-thinking assumptions. |
| DeepSeek's reasoning extension was rejected on input and dropped by the OpenAI-specific SDK provider. | Accept nullable `reasoning_content`; preserve assistant reasoning parts; use the SDK compatible provider for DeepSeek, Qwen reasoning, Kimi, MiniMax, GLM and MiMo. Preserve reasoning in non-stream responses as well as streams. | Tool continuations can replay reasoning, including earlier assistant turns. No fabricated reasoning for clients that omit it. |
| Both protocol paths disabled thinking for every required tool choice. | Remove the global suppression; preserve caller mode and let the endpoint enforce supported combinations. | Avoids silently downgrading reasoning. |
| Original adapter passed an unsupported `reasoningParser` option to the SDK. | Remove it; parse the actual endpoint protocol through the supported provider package. | Avoids a setting that appeared to work but did nothing. |
| Tool-name streaks, read counts, and planning language triggered forced action. | Nudge only consecutive identical full-argument calls with explicit failure results. | Successful rereads, pagination, research and distinct edits remain valid. |
| Loop identity lowercased paths and truncated arguments. | Stable SHA-256 identity over full, case-sensitive, key-sorted arguments. | Different read offsets and long edits no longer collide. |
| Prompts prescribed heredocs, full-file rewrites, relative paths, and immediate commits. | Short shared schema guidance; retain native tool descriptions and client execution semantics. | Reduces prompt overhead and avoids bypassing native permissions or editing workflows. |
| Repair code promoted arbitrary values to executable commands or joined malformed arrays into file contents. | Repair only an unambiguous known command alias; reject semantic guesses. | Malformed output cannot silently become a different operation. |
| Hardcoded model-name heuristics imposed 55–90% working-context ratios and unmeasured quality/risk ratings. | Preserve configured context capacity and unknown quality traits; retain explicit measured registry overrides. | Avoids unnecessary compaction and unsupported reliability claims. |
| Compaction-sensitive profiles were compacted more aggressively. | Prefer minimal compaction when sensitivity is explicitly declared. | Preserves state where compaction is known to be risky. |
| Adaptive architecture mode enabled extra passes and governor bias by default. | No model-family governor bias; multipass remains off unless explicitly configured or aggressive mode selected. | Reduces automatic intervention and extra inference cost. |
| Output deduplication masked digits and sampled lines. | Compare complete byte-identical output only; existing protected-result rules remain. | Different numeric results or changed source lines cannot be treated as duplicates. |
| Structured assistant compaction could drop reasoning/tool-call parts. | Preserve non-text parts when stubbing; transcript condensation leaves structured assistant messages intact. | Retained messages keep their protocol-critical content. |
| Kimi Coding identified Synesis as Claude Code. | Send Synesis' own User-Agent; retain explicit deployment override. | Honest client identity. Subscription access still depends on the provider's approved integrations. |

## Verified model distinctions

| Model/version | Evidence and handling |
| --- | --- |
| DeepSeek V4 | Hybrid CSA/HCA attention, distinct from V3 MLA. Thinking tool use requires replay of prior assistant reasoning. `enable_thinking` translates to DeepSeek's `thinking.type`; reasoning effort accepts `max`/`xhigh` in addition to existing values. [Model card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro), [thinking protocol](https://api-docs.deepseek.com/guides/thinking_mode/) |
| DeepSeek V3 / R1 / V3.2 | V3/R1 use MLA; V3.2 introduces DSA. Distilled R1 models do not inherit the original architecture. Broad `deepseek` names no longer imply V4. [V3](https://huggingface.co/deepseek-ai/DeepSeek-V3), [V3.2](https://huggingface.co/deepseek-ai/DeepSeek-V3.2) |
| Qwen3 Coder / Coder Next | Original Coder and Next have different sampling recommendations; Next is non-thinking and uses hybrid linear/full attention. A local/vLLM hostname does not prove the correct tool parser is configured. [Original](https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct), [Next](https://huggingface.co/Qwen/Qwen3-Coder-Next) |
| Qwen3.5 / Qwen3.6 | Gated DeltaNet/full-attention hybrids; Qwen3.6 documents optional historical thinking preservation. The legacy architecture enum has no exact linear/full value, so attention remains unknown with an explanatory note. No automatic context penalty. [3.5](https://huggingface.co/Qwen/Qwen3.5-397B-A17B), [3.6](https://huggingface.co/Qwen/Qwen3.6-35B-A3B) |
| GLM-5 | DSA architecture and a dedicated GLM adapter/card. Sparse attention is not evidence of poor recall. [Model card](https://huggingface.co/zai-org/GLM-5), [technical report](https://arxiv.org/abs/2602.15763) |
| Kimi K2/K2.5 | MLA; thinking and instant modes recommend different temperatures. Remove unconditional family sampling. Later/opaque variants retain unknown architectural traits. [K2.5](https://huggingface.co/moonshotai/Kimi-K2.5) |
| MiniMax M2/M2.5 | Interleaved reasoning must remain available. Remove the unsupported family-level speculative-decoding and compressed-context claims. [M2](https://huggingface.co/MiniMaxAI/MiniMax-M2), [M2.5](https://huggingface.co/MiniMaxAI/MiniMax-M2.5) |
| Xiaomi MiMo | Preserve reasoning and native tool semantics. Leave deployment performance/recall/decoding unknown rather than deriving them from MiMo branding. [V2.5 Pro](https://huggingface.co/XiaomiMiMo/MiMo-V2.5-Pro) |
| Other/proprietary models | Generic compatibility and universal validation remain available. No invented attention, activation, context penalty, or runtime-decoding claims from brand names. Explicit registry overrides remain available. |

## Sparse attention, n-grams and papers

Sparse attention is an implementation of attention, not permission for the proxy to discard content. MLA compresses KV representations; hybrid linear attention and DSA have different mechanisms. Their workload behavior must be measured separately. Declared capacity is an admission ceiling, not a guarantee of perfect recall; output reservation and ordinary budget controls still apply.

[Engram](https://arxiv.org/abs/2601.07372) adds trained conditional memory through n-gram lookup. It requires model/training integration; inserting n-grams in prompts or fuzzy-deduplicating transcripts does not reproduce it. No extra n-gram prompt layer was added.

[N-gram speculative decoding in vLLM](https://docs.vllm.ai/en/latest/features/speculative_decoding/) is a serving optimization. Evaluate acceptance rate, throughput, latency and output equivalence on the deployed runtime before enabling it. MTP training likewise does not prove an endpoint uses speculative decoding. Validate complete streamed tool calls for every model, independent of how the server generates tokens.

The adopted lesson is to preserve protocol state, use exact reversible reduction where possible, and gate behavioral changes on task-level evidence. We did not adopt paper-specific mechanisms the proxy cannot implement.

## Validation and remaining deployment work

Regression tests cover model-card precedence, current variants, successful versus failed tool repetition, full-argument identity, non-inventive repairs, numeric/source output differences, preserved reasoning, and real SDK serialization/parsing against mocked HTTP responses (streaming and non-streaming). Yarn, the shared upper harness, and Planner are checked together because architecture policy is shared.

Validation completed: 3,498 Yarn tests, 564 Planner tests and 43 shared upper-harness tests passed. All three builds passed, touched TypeScript passed ESLint with zero warnings, and JSON Schema contract parity and diff checks passed. Replayed reasoning is included in context token estimates.

These are compatibility tests, not live quality certification. No paid model benchmark or authenticated provider canary was run. Before promoting a model deployment, exercise its actual chat template/tool parser, thinking on/off, multi-turn tool reasoning replay, structured output, long-context retrieval, compaction recovery, cancellations and usage reporting. Compare task success, false intervention rate, tokens, latency and recoverable context loss against an unmodified baseline. Use measured registry overrides only when the result justifies them.

Clients must return provider-required reasoning history. The proxy cannot recover omitted history by inventing text. Qwen thinking preservation also depends on the endpoint's chat-template configuration. Tool parser configuration, top-k support, structured-output dialects and subscription access remain endpoint capabilities, not guarantees implied by a model-family match.
