# Planner Architecture Mediation

Planner can now use the same shared architecture policy layer as Yarn through
`@synesis/upper-harness`, with Planner-specific mediation for long Open WebUI
chat, roleplay, tutoring, advisory, and RAG-grounded sessions.

This is an upper-harness behavior layer. It does not change model internals,
attention kernels, MoE routing, provider APIs, or vLLM/SGLang serving behavior.
It changes how Planner prepares, filters, reinforces, and verifies context
before sending prompts to the selected writer/planner model.

## Why Planner Needs It

OpenAI-compatible chat endpoints hide important model differences. A full
attention model, a sliding-window model, an MLA-style model, and a compressed
long-context model can all expose the same `/v1/chat/completions` interface but
behave differently in long chats.

Planner treats large declared context as addressable storage when the selected
architecture profile indicates long-context compression. The reliable working
set is reinforced with active state, fact pins, evidence IDs, and hygiene
signals near the planner/writer prompts.

This is especially useful for:

- Open WebUI sessions with many follow-up turns;
- roleplay or creative continuity where canon must stay stable;
- tutoring drills where the latest short answer depends on prior state;
- long advisory sessions with persistent goals and constraints;
- RAG answers where evidence IDs and citations need to stay close to the final
  writer prompt;
- DeepSeek/Qwen/Kimi/MiniMax-class models where large context does not always
  mean dense recall.

## Request Controls

Planner accepts the same canonical mediation controls as Yarn.

HTTP headers:

```http
x-synesis-context-mediation: off|observe|safe|adaptive|aggressive
x-synesis-architecture-profile: raw|auto|model-registry
```

OpenAI-compatible metadata:

```json
{
  "metadata": {
    "synesis": {
      "contextMediation": "adaptive",
      "architectureProfile": "auto"
    }
  }
}
```

Mode behavior:

- `off`: no architecture mediation and no Planner active-state injection.
- `observe`: compute profile, hygiene, pins, manifest, and trace artifacts, but
  do not alter prompts.
- `safe`: filter obvious duplicate/stale low-value context and keep strict
  validation posture without extra model passes.
- `adaptive`: inject Planner active state when the resolved architecture policy
  benefits from it; allow at most one repair path for critical
  fact/reference/structure issues.
- `aggressive`: use the same artifacts with a stronger retrieve-answer-verify
  posture, still bounded to one repair pass.

Legacy direct metadata aliases remain accepted for migration compatibility, but
new clients should emit only the nested `metadata.synesis.*` shape.

## Active State Packet

For mediated graph/writer requests, Planner can build a
`SYNESIS_PLANNER_ACTIVE_STATE` block. It is not hidden memory. It is a compact,
auditable prompt artifact derived from the request/session state.

It can include:

- selected context interpretation, such as `storage_with_working_set`;
- active chat profile;
- latest user task;
- hygiene score;
- critical fact pins from user constraints, security/schema obligations, tool
  results, file references, and task commitments;
- evidence manifest IDs and summaries;
- planner assumptions and unresolved questions;
- recent decision-ledger commitments.

The packet is injected near the planner/writer prompts for `adaptive` and
`aggressive`, observed but not injected for `observe`, and skipped for `off`.

Native tool passthrough requests remain behavior-compatible in v1. Planner does
not inject active-state prompt blocks into native OpenAI tool-call traffic.

## Built-In Chat Profiles

Planner infers a lightweight chat profile from the latest task, recent
conversation, and evidence availability:

| Profile | Intended behavior |
|---------|-------------------|
| `general_assistant` | Answer the latest request directly while preserving explicit constraints and preferences. |
| `tutoring_study` | Preserve learner level, last exercise state, and drill style; interpret short answers in context. |
| `long_form_advisory` | Preserve goals, constraints, assumptions, and prior recommendations across long sessions. |
| `roleplay_creative_continuity` | Pin canon, character voice, scene state, unresolved beats, and user boundaries; continue the scene unless asked to summarize. |
| `rag_grounded_answer` | Keep source IDs and evidence close to the writer prompt; avoid unsupported citations. |

Admins can override or extend profile behavior with Prompt Library assignments
using target type `chat_profile` and one of the profile slugs above. Built-in
profiles stay in code so Open WebUI works well without requiring prompt-library
configuration.

## Model-Family Defaults

The built-in model-family profiles are conservative harness defaults. They are
not claims about provider internals, and admin registry overrides remain
authoritative.

- DeepSeek/MLA-style: stronger active-state replay, fact pins near the prompt
  tail, JSON/structured-output repair posture, and latest-state preference over
  stale transcript context.
- Qwen/global-local hybrid: anti-repetition pressure, follow-up interpretation,
  concise state grounding, and medium-risk long-context verification.
- Kimi/Moonshot-style: explicit long-context state replay, evidence manifest
  emphasis, citation/reference checks, and shorter answer sections when useful.
- MiniMax/heavily compressed style: short-turn bias, strict reference checks,
  duplicate/stale context filtering, and bounded repair.
- Full-attention models: avoid unnecessary heavy active-state prompt churn by
  default while still allowing request/admin overrides.

Unknown models use conservative defaults: explicit state headers, context
hygiene, structured validation, and recent-state replay.

## Public Offerings and Admin Overrides

Planner resolves mediation against the writer model actually used for the
request, not just the client-facing `model` string. Public model offerings may
therefore expose stable names such as `Synesis Core` or `deepseek-v4-chat` while
mediation follows the resolved backend writer model and route provider.

Recommended configuration path:

1. Create or update the public offering in **Admin -> Models & costs -> Model
   Registry**.
2. Set the backend model override or role route so Planner resolves the actual
   writer model.
3. Use Prompt Library `model_family` overlays for broad family behavior.
4. Use Prompt Library `chat_profile` overlays for scenario behavior.
5. Use request metadata/header overrides for one-off testing.

For this Planner release, architecture-profile admin overrides are shared with
the Yarn upper-harness policy library at the code level. Public API behavior is
additive: OpenAI-compatible request/response envelopes and SSE chunks remain
unchanged unless mediation is explicitly enabled by mode/config.

## Diagnostics

Planner trace context can include:

- selected architecture profile and mediation mode;
- attention architecture and compression interpretation;
- context budget interpretation;
- chat profile;
- hygiene score and removed-message count;
- active-state header hash;
- critical fact pin count;
- evidence manifest count;
- verification warnings.

Search Planner logs for `planner_context_selection_v1` to see selected context
and mediation summary for a request. Full trace metadata is emitted under
`trace_context.architecture_mediation` for normal graph/writer requests.

## Evaluation Matrix

The deterministic eval matrix lives in
`base/planner-ts/tests/openwebui-eval-matrix.test.ts`. It covers:

- long chat follow-ups;
- roleplay continuity;
- tutoring drills;
- RAG-grounded answers;
- DeepSeek, Qwen, Kimi/Moonshot, and MiniMax-style model aliases.

The matrix verifies profile selection, active-state injection, evidence
manifest generation, and bounded repair posture. It is not a substitute for
live model quality evaluation. Use it as a regression guard, then run live
Open WebUI sessions against configured providers to measure continuity,
repetition, missed constraints, stale facts, citation accuracy, and JSON repair
rate.

## Practical Defaults

For most Open WebUI deployments:

- keep default mediation at `adaptive`;
- use `observe` while evaluating a new provider route;
- use `safe` if compatibility risk is more important than continuity gains;
- use `aggressive` only for long-context tasks where verification/repair cost is
  acceptable;
- use `off` to debug raw provider behavior.

This gives Planner better cross-model behavior without pretending every model
has the same dense working memory.
