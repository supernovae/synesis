# Model Architecture Awareness

Synesis Yarn is an OpenAI-compatible control layer above heterogeneous model
runtimes. It does not change model internals, attention kernels, MoE routing,
or speculative decoding behavior in vLLM, SGLang, or hosted providers. Instead,
Yarn preserves model protocol requirements and applies configured harness policy
for the model behind the endpoint.

## Evidence and limits

Model architecture, endpoint transport, and client tool semantics are independent.
The [model compatibility guide](model-compatibility.md) records verified model
versions, removed heuristics, research sources and deployment validation limits.

Architecture names do not establish recall quality, safe working-context ratios,
short-turn requirements, or runtime speculative decoding. Unknown behavior stays
unknown. The configured context capacity is preserved unless a measured registry
override supplies a lower operating limit; ordinary output reservation and context
admission still apply. Compaction-sensitive overrides prefer minimal compaction.

State headers, evidence manifests, exact deduplication and deterministic validation
are ordinary harness controls. They are not repairs to model attention. Built-in
profiles do not add governor bias, stale-keyword deletion, or extra model passes
based on model branding.

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
- `safe`: filter duplicate low-value context (staleness filtering requires an explicit override) and enforce strict
  tool/schema boundaries without extra model passes;
- `adaptive`: apply architecture-aware active state, fact pins, evidence
  manifests; repair passes require an explicit registry recommendation;
- `aggressive`: run one retrieve-answer-verify-repair pass for long-context
  tasks and return the repaired result with trace metadata.

Legacy direct metadata keys such as `synesis_architecture_mediation`,
`architecture_mediation`, and `synesis_memory` remain accepted as migration
aliases. Synesis emits and documents only `metadata.synesis.contextMediation`.

This keeps raw OpenAI-compatible usage and conservative client rollouts possible
while letting developer tools opt into a stronger upper harness when the model
architecture benefits from it.

## Durable Work Packets

When the selected policy requests state reinforcement, Yarn can derive compact
active-state artifacts from existing session signals. Architecture names alone
do not establish a need for these artifacts.
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

`off` disables architecture mediation; authentication, schema validation and other
independently configured runtime controls still apply. `observe` builds and traces artifacts without
injecting them. `safe` may filter duplicate low-value context; stale filtering requires an override.
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
automatic inference from model ID. These presets are harness policy
defaults for mediation, adapter hints, and cache diagnostics; they are not
freeform claims about the provider or serving stack.

Admins can also override inferred profiles through model registry route params.
The first pass supports either an `architecture_profile` object or direct
fields:

For example, an operator might set the following **after measuring** an endpoint
and workload. These numbers are illustrative, not recommended model defaults:

```json
{
  "effective_working_context_tokens": 90000,
  "safe_tool_output_tokens": 16000,
  "architecture_compaction_sensitivity": "high",
  "default_context_mediation_mode": "adaptive"
}
```

Record the model/version, serving configuration, workload and evaluation result
with an override. Architectural facts alone do not establish these limits.

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

- DeepSeek V4 is distinct from V3/R1 MLA and V3.2 DSA. None receives an automatic capacity discount.
- Qwen3 Coder Next and Qwen3.5/3.6 use hybrid linear/full attention. Qwen3.8-27B and Flash-Next have distinct hybrid designs; Flash-Next also includes learned n-gram embeddings and Qwen Sparse Attention. The legacy enum leaves these attention combinations unknown with explanatory notes.
- MTP training does not identify the serving algorithm or HTTP chunk boundaries.
- Unknown/proprietary models retain unknown architecture and quality traits.
- A measured registry override can lower the operating context ceiling or enable bounded repair passes.
