# Model Architecture Awareness

Synesis Yarn is an OpenAI-compatible control layer above heterogeneous model
runtimes. It does not change model internals, attention kernels, MoE routing,
or speculative decoding behavior in vLLM, SGLang, or hosted providers. Instead,
Yarn adapts developer-harness behavior to the architecture traits of the model
behind the endpoint.

## Why Provider Names Are Not Enough

Provider/model-family handling catches useful quirks such as tool argument
shape, thinking support, and endpoint capabilities. It does not describe how a
model behaves under long coding sessions. Two models behind the same
OpenAI-compatible API can differ sharply:

- full-attention models may tolerate larger working transcripts;
- sliding-window models can lose long-tail state even when the declared context
  window is large;
- MLA / attention-compressed models may need explicit state packets rather than
  raw transcript volume;
- MoE models benefit from deterministic phase labels and stricter validation;
- MTP or speculative-friendly serving needs careful stream/tool-call boundary
  validation;
- high-throughput cheap-output models may need shorter turns and recent task
  state replay.

When users say “the model is getting dumb,” the issue is often a platform
mediation problem: old state is weakly attended, tool results are too verbose,
or the harness assumes the provider’s declared context window equals reliable
working memory.

## What Yarn Controls

Yarn’s `ModelArchitectureProfile` and derived `ModelExecutionPolicy` make those
tradeoffs explicit. The first pass applies policy to:

- effective context ceilings used by context admission;
- compaction aggressiveness for weak long-tail or SWA-like profiles;
- explicit current-state/task-state instructions near the model message stream;
- deterministic validation and structured tool-output preferences;
- trace and cache diagnostics explaining which architecture policy was selected.

Unknown models degrade to conservative defaults: explicit state headers,
structured tool digests, recent task replay, deterministic validation, and a
reduced effective working context when no better signal exists.

## Admin Overrides

Admins can override inferred profiles through model registry route params. The
first pass supports either an `architecture_profile` object or direct fields:

```json
{
  "architecture_attention": "mla",
  "architecture_activation": "moe",
  "architecture_decoding": "speculative_friendly",
  "effective_working_context_tokens": 90000,
  "safe_instruction_tokens": 10000,
  "safe_tool_output_tokens": 16000,
  "architecture_compaction_sensitivity": "high"
}
```

These overrides are harness policy, not claims about the actual inference
engine. Operators should prefer cautious settings unless they have trace data
showing stronger behavior.

## Operator Diagnostics

Yarn exposes the selected profile and derived execution policy through the
internal diagnostics surface:

```text
GET /v1/diagnostics/model-architecture
```

The route requires the same internal diagnostics token as the other diagnostics
endpoints and does not change the public OpenAI-compatible `/v1/models` shape.
It reports each configured model alias, resolved backend model, endpoint
provider, adapter family, whether an admin override applied, and the compact
architecture policy trace used by request handling.

## Examples

- DeepSeek-style MLA model: Yarn treats declared context as larger than reliable
  working memory, prefers memory stitching, and keeps high-signal decisions in
  explicit state headers.
- MoE coder: Yarn favors deterministic validation and clearer phase/task labels
  to reduce ambiguous instruction blends.
- Throughput-optimized model: Yarn encourages shorter turns, structured tool
  digests, recent task replay, and safer retries so lower developer harnesses do
  not each need to rediscover the same mediation rules.

This is the product boundary: Synesis is not a dumb proxy and not a magic
long-context repair system. It is architecture-aware model mediation that
normalizes developer experience across different model runtimes.
