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

## Mediation Modes

Architecture policy is deterministic and can be dialed per deployment or per
request. The deployment default is `adapt`, which preserves normal Yarn
developer-harness behavior. Requests can override it with
`metadata.synesis_architecture_mediation` or
`extra_body.synesis_architecture_mediation`:

- `off`: do not apply architecture budget or prompt mediation for the request;
- `observe`: resolve and trace the profile/policy, but do not alter budget
  ceilings, compaction, or prompt hints;
- `adapt`: apply the normal architecture-aware context and prompt mediation;
- `strict`: opt in to stronger stream/tool boundary validation for experiments.

This keeps raw OpenAI-compatible usage and conservative client rollouts possible
while letting developer tools opt into a stronger upper harness when the model
architecture benefits from it.

## Durable Work Packets

For models with weak long-tail retention, sliding-window behavior, MLA-style
attention compression, or high retry sensitivity, Yarn can derive a compact
`SYNESIS_CURRENT_WORK_PACKET` from existing session signals. The packet is not
hidden model memory and does not override filesystem/tool truth. It is a
deterministic tail-state replay containing the current objective, path context,
task ledger, recent files, latest tool truth, blockers, do-not-repeat guidance,
and one next best action.

Clients can control this mediation with request metadata or `extra_body`:

```json
{
  "metadata": {
    "synesis_memory": "off | observe | adapt | strict"
  }
}
```

- `off`: do not build or inject the current work packet for the request;
- `observe`: build and trace the packet, but do not inject it;
- `adapt`: inject only when the selected architecture policy benefits from
  recent state replay;
- `strict`: always inject the packet when it has useful state.

Users can set the same default in **Account -> Coder runtime controls ->
Synesis memory**. The persisted preference is `synesisMemoryMode`; request
metadata remains the highest-precedence override for a single run.

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

The trace includes `mediation_mode` plus booleans for context-budget, prompt-hint,
and governor-bias application, so admins can distinguish “observed profile” from
“profile actively changed request handling.”

## Examples

- DeepSeek-style MLA model: Yarn treats declared context as larger than reliable
  working memory, prefers memory stitching, and keeps high-signal decisions in
  explicit state headers.
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
normalizes developer experience across different model runtimes.
