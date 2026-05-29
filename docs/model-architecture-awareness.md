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
- global/local hybrid and compressed sparse attention models may expose large
  context as addressable storage rather than dense working memory;
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
- storage-vs-working-set context interpretation for compressed long-context
  models;
- compaction aggressiveness for weak long-tail or SWA-like profiles;
- active state headers, critical fact pins, and evidence manifests near the
  model working set;
- deterministic validation, structured tool-output preferences, citation
  checks, and missing-reference checks;
- trace and cache diagnostics explaining which architecture policy was selected.

Unknown models degrade to conservative defaults: explicit state headers,
structured tool digests, recent task replay, deterministic validation, and a
reduced effective working context when no better signal exists.

## Mediation Modes

Architecture policy is deterministic and can be dialed per deployment or per
request. The deployment default is `adaptive`, which preserves normal Yarn
developer-harness behavior while enabling bounded state reinforcement for
models that benefit from it. Requests can override it with the
`x-synesis-context-mediation` header or nested OpenAI metadata:

```json
{
  "metadata": {
    "synesis": {
      "contextMediation": "off | observe | safe | adaptive | aggressive",
      "architectureProfile": "raw | auto | model-registry"
    }
  }
}
```

- `off`: do not apply architecture budget or prompt mediation for the request;
- `observe`: resolve and trace the profile/policy, but do not alter budget
  ceilings, compaction, or prompt hints;
- `safe`: filter obvious duplicate/stale low-value context and enforce strict
  tool/schema boundaries without extra model passes;
- `adaptive`: apply architecture-aware active state, fact pins, evidence
  manifests, and at most one repair pass for critical fact/reference violations;
- `aggressive`: run one retrieve-answer-verify-repair pass for long-context
  tasks and return the repaired result with trace metadata.

Legacy direct metadata keys such as `synesis_architecture_mediation`,
`architecture_mediation`, and `synesis_memory` remain accepted as migration
aliases. Synesis emits and documents only `metadata.synesis.contextMediation`.

This keeps raw OpenAI-compatible usage and conservative client rollouts possible
while letting developer tools opt into a stronger upper harness when the model
architecture benefits from it.

## Durable Work Packets

For models with weak long-tail retention, sliding-window behavior, MLA-style
attention compression, hybrid compressed attention, or high retry sensitivity,
Yarn can derive compact active-state artifacts from existing session signals.
The artifacts are not hidden model memory and do not override filesystem/tool
truth. They can include:

- `SYNESIS_ACTIVE_STATE`: current objective, critical fact pins, evidence block
  IDs, hygiene score, and context-budget interpretation;
- `SYNESIS_CURRENT_WORK_PACKET`: deterministic tail-state replay containing the
  current objective, path context, task ledger, recent files, latest tool truth,
  blockers, do-not-repeat guidance, and one next best action;
- hygiene reports counting duplicate, stale, contradictory, low-relevance,
  critical fact, and manifest blocks;
- verification warnings for missing block IDs, stale references, critical fact
  recall gaps, and quote/citation risk.

`off` performs raw pass-through. `observe` builds and traces artifacts without
injecting them. `safe` may filter obvious duplicate/stale low-value context.
`adaptive` injects active state when the selected architecture policy benefits
from it. `aggressive` uses the same bounded artifacts with one verify/repair
opportunity.

Users can set the same default in **Account -> Coder runtime controls ->
Synesis memory**. The persisted preference is `synesisMemoryMode` with values
`off`, `observe`, `safe`, `adaptive`, or `aggressive`; request metadata remains
the highest-precedence override for a single run.

Yarn emits a `current_work_packet_v1` session event with the packet hash, token
estimate, source sections, policy reasons, and injected/observed mode. Admin
session detail renders the latest packet so operators can see exactly what the
upper harness believed and why it replayed that state.

Claude-compatible clients can expose the same state through the command
compatibility endpoint:

```http
POST /v1/claude/commands/execute
{
  "command": "show_memory",
  "conversation_id": "..."
}
```

Accepted inspection aliases are `memory`, `show_memory`,
`current_work_packet`, and `work_packet`. Accepted clear aliases are
`clear_memory`, `clear_work_packet`, and `reset_memory`. Clearing removes the
persisted packet summary from the Yarn session; later requests may rebuild a
new packet from current tool truth and session events. Admin MCP exposes the
same read-only view as `yarn_current_work_packet`.

## Admin Overrides

Admins can select a controlled **model capability preset** on a model registry
role or public offering. The preset travels with the registered model
class/version rather than the endpoint host, so one OpenAI-compatible provider
can safely serve DeepSeek, Qwen, Kimi, GLM, MiniMax, and Xiaomi routes without
forcing all of them through one provider-level behavior.

Supported preset ids are intentionally finite:

```text
generic_openai_compatible
deepseek_v3
deepseek_v4
qwen_3
qwen_3_coder
kimi_k2
glm_4_5
minimax_m1
minimax_m2
xiaomi_mimo_2
xiaomi_mimo_2_5
```

Use `generic_openai_compatible` when an opaque model id should suppress
name-based architecture inference. Leave the preset unset to use conservative
automatic inference from model id/provider. These presets are harness policy
defaults for mediation, adapter hints, and cache diagnostics; they are not
freeform claims about the provider or serving stack.

Admins can also override inferred profiles through model registry route params.
The first pass supports either an `architecture_profile` object or direct
fields:

```json
{
  "model_capability_preset": "deepseek_v4",
  "architecture_attention": "hybrid_compressed_attention",
  "architecture_activation": "moe",
  "architecture_decoding": "speculative_friendly",
  "architecture_compression_local_path": "global_local",
  "architecture_compression_long_range_path": "retrieval_compressed",
  "architecture_context_interpretation": "storage_with_working_set",
  "effective_working_context_tokens": 90000,
  "safe_instruction_tokens": 10000,
  "safe_tool_output_tokens": 16000,
  "architecture_compaction_sensitivity": "high",
  "architecture_exact_needle_recall_reliability": "weak",
  "architecture_critical_fact_pins": true,
  "architecture_evidence_manifest": true,
  "default_context_mediation_mode": "adaptive"
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

The trace includes `mediation_mode`, attention compression, context budget
interpretation, hygiene decisions, active-state recommendations, validation
settings, and multipass limits, so admins can distinguish “observed profile”
from “profile actively changed request handling.”

## Examples

- DeepSeek-style MLA model: Yarn applies harness policy defaults that treat
  declared context as larger than reliable working memory, prefer memory
  stitching, and keep high-signal decisions in explicit state headers.
- Xiaomi MiMo model: Yarn treats MiMo-V2.5 Pro as a long-agent MoE profile with
  explicit current-state replay, and treats MiMo Flash as SWA/MTP-sensitive so
  short turns, path discipline, and stream/tool boundary checks stay prominent.
- MoE coder: Yarn favors deterministic validation and clearer phase/task labels
  to reduce ambiguous instruction blends.
- Throughput-optimized model: Yarn encourages shorter turns, structured tool
  digests, recent task replay, and safer retries so lower developer harnesses do
  not each need to rediscover the same mediation rules.

This is the product boundary: Synesis is not a dumb proxy and not a magic
long-context repair system. It is architecture-aware model mediation that
normalizes developer experience across different model runtimes. Built-in
example profiles are harness policy defaults, not authoritative claims about a
provider's model internals; admin registry overrides remain authoritative.
