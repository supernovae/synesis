# Token Optimization Architecture

Yarn is the Synesis OpenAI-compatible developer runtime between IDE/agent
harnesses and model providers. Its token optimization work is intentionally an
upper-harness concern: Yarn does not change model internals, but it can make the
payload sent to those models smaller, more stable, easier to cache, and easier to
debug.

This document reflects the post-refactor Yarn shape. The old monolithic
`src/index.ts` request path has been split into route modules, pipeline stages,
provider preparation, streaming/non-streaming execution, persistence runners, and
telemetry helpers. Token optimization now lives in those seams instead of being
hidden inside one large route handler.

## Goals

1. **Preserve API compatibility.** OpenAI-compatible chat completions, Claude
   Messages compatibility, SSE chunk shape, auth behavior, model routes, health,
   readiness, metrics, and documented errors must remain stable.
2. **Fail safe to pass-through.** Optimization failures should degrade to the
   safest compatible request, not block developer work.
3. **Keep prefix bytes stable.** Stable system/developer blocks, tool schemas,
   provider options, transcript prefixes, cache policy, and model/provider
   resolution should not churn unless the logical input changed.
4. **Spend tokens where they help.** Preserve recent state, unresolved failures,
   active files, task ledger state, and high-signal tool output. Compact stale,
   duplicated, or low-signal material.
5. **Make cache behavior observable.** Every request should expose enough hashes,
   timings, and provider usage data to explain whether cache misses come from
   unstable prefixes, tool schema churn, provider options, transcript churn,
   cache policy, model/provider resolution, or upstream provider behavior.
6. **Adapt by model architecture.** Full-attention, sliding-window, MLA,
   hybrid, MoE, speculative/MTP, and unknown models need different harness
   policies. Yarn mediates those differences above inference.
7. **Validate with labs, not vibes.** Replay fixtures, eval-gym scenarios,
   Eval Client Lab, and Harness Lab are the promotion path for governor and
   token-efficiency behavior.

## Current Request Shape

`src/index.ts` is now primarily server bootstrap and dependency assembly. Route
registration and request behavior are delegated to:

| Area | Main modules |
|------|--------------|
| Route registration | `src/server/route-registration.ts`, `src/server/non-chat-routes.ts`, `src/routes/*` |
| OpenAI route | `src/routes/openai-chat-completions-route.ts`, `src/pipeline/openai-chat-pipeline.ts` |
| Claude route | `src/routes/claude-messages-route.ts`, `src/streaming/claude-stream-route.ts`, `src/streaming/claude-nonstream-route.ts` |
| OpenAI preparation | `src/pipeline/openai-route-request-setup.ts`, `src/pipeline/openai-route-normalization.ts`, `src/pipeline/openai-route-transcript-prep.ts`, `src/pipeline/openai-route-transcript-stabilization.ts` |
| Context/governance | `src/pipeline/openai-context-preparation.ts`, `src/pipeline/openai-enrichment-preparation.ts`, `src/pipeline/openai-execution-governor-preparation.ts`, `src/pipeline/route-context-admission.ts` |
| Provider execution | `src/pipeline/openai-chat-provider-preparation.ts`, `src/pipeline/openai-chat-provider-execution.ts`, `src/pipeline/openai-provider-route-execution.ts`, `src/pipeline/openai-provider-runtime-preparation.ts` |
| Streaming | `src/pipeline/openai-stream-route-pipeline.ts`, `src/streaming/openai-streaming-pipeline.ts`, `src/streaming/*` |
| Persistence | `src/state/session-persistence-runner.ts`, `src/state/session-usage-persistence.ts`, `src/state/persistence-token-economics.ts`, `src/state/route-persistence-scope.ts` |
| Telemetry | `src/telemetry/optimization-ledger.ts`, `src/telemetry/cache-shape-diagnostics.ts`, `src/telemetry/request-forensics.ts`, `src/telemetry/request-forensics-recorder.ts` |

The important architectural change is that token optimization is no longer one
blob of route-local code. It has named stages with places to measure, bypass,
and test.

## Pipeline Stages

The practical request pipeline is:

```text
ingress/auth/schema/session identity
  -> mode resolution
  -> protocol compatibility normalization
  -> transcript/tool normalization
  -> reduction and pruning
  -> route/session/workspace context
  -> model architecture policy
  -> enrichment and state replay
  -> governor/policy intervention
  -> provider request construction
  -> cache-shape diagnostics
  -> provider call or stream loop
  -> response normalization
  -> session/usage/token-economics persistence
  -> telemetry and diagnostics
```

The stages are measured through `OptimizationLedger.startStage()` with stage
names such as:

- `ingress`
- `normalization`
- `pruning`
- `context`
- `governor`
- `enrichment`
- `provider_request`
- `provider`
- `stream`
- `persistence`

These timings are not just performance metrics. They also make it possible to
identify whether a cache-rate problem is tied to request normalization,
enrichment, provider option construction, streaming finalization, or persistence.

## Pipeline Modes

`src/pipeline/modes.ts` defines the runtime mode:

| Mode | Intent |
|------|--------|
| `raw` | Minimize Synesis behavioral steering and heavy enrichment. Preserve raw OpenAI-compatible pass-through as a first-class mode. |
| `compat` | Normalize compatibility edges while avoiding heavier optimization/governor behavior. |
| `optimized` | Apply token optimization and context shaping without full governor intervention. |
| `governed` | Current default behavior for developer harnesses that need governor/policy support. |
| `workflow` | Reserved for explicit future Step/FSM/DAG-style workflows. |

The `x-synesis-mode` header can opt down where supported. Raw/compat modes are
important for cache experiments because they provide a baseline: if raw/compat
has better cache behavior than governed/optimized, the difference should be
visible in cache-shape diagnostics and stage timings.

## Token Reduction

Token reduction operates before provider request construction. Its job is to
reduce low-signal bytes without removing facts the model needs.

| Capability | Main modules | Purpose |
|------------|--------------|---------|
| Tool result reduction | `src/reduction/tool-result-reducer.ts`, `src/reduction/registry.ts` | Reduce build/test/lint/git/search/tool output into structured summaries. |
| Validation normalization | `src/validation/service.ts` | Normalize test/lint output and optionally use a cheap fallback model for ambiguous output. |
| Transcript pruning | `src/reduction/transcript-pruning.ts` | Remove stale duplicate commands, duplicate file reads, old tool results, near-duplicate output, and excessive assistant narration. |
| Read snapshot normalization | `src/reduction/read-snapshot-normalizer.ts`, `src/reduction/file-snapshot-registry.ts` | Convert unchanged file reads into compact snapshot references or replay content when needed. |
| Content-addressed dedup | `src/reduction/content-addressed-dedup.ts` | Stub repeated identical file content by content hash. |
| Response dedup | `src/dedupe/ResponseDedupe.ts` | Stub repeated idempotent tool results with the same tool/args/result hash. |
| Historical normalization | `src/reduction/historical-normalizer.ts` | Stabilize old timestamps, paths, blank lines, and tool-call IDs for prefix-cache friendliness. |
| Jitter buffer | `src/compat/jitter-buffer.ts` | Move volatile cwd/session/date/runtime metadata out of the stable prefix and into trailing environment context. |

Reduction is intentionally conservative near the active turn. The most recent
tool result, unresolved failures, active files, and current task state should
remain explicit unless a hard context ceiling requires emergency compaction.

## Context Budgeting And Admission

Context budget policy is enforced in two layers:

1. **Budget management and compaction**
   - `src/governance/context-budget-manager.ts`
   - `src/governance/context-retention.ts`
   - `src/governance/context-checkpoint.ts`
   - `src/context/sawtooth-manager.ts`

2. **Route admission**
   - `src/pipeline/context-admission.ts`
   - `src/pipeline/route-context-admission.ts`
   - `src/policy/deterministic-policy-engine.ts`

The default compaction mode remains `minimal`. Minimal mode trusts modern
developer harnesses to manage much of their own transcript and avoids injecting
stale server summaries unless the request is approaching hard limits.

`aggressive` mode is still available for weak or raw clients, but it is
deliberately opt-in because aggressive compaction can hurt developer agents that
already maintain a good local context window.

Important flags:

| Flag | Default | Role |
|------|---------|------|
| `SYNESIS_YARN_CONTEXT_BUDGET_ENABLED` | `true` | Enables budget manager. |
| `SYNESIS_YARN_CONTEXT_BUDGET_COMPACTION_MODE` | `minimal` | `minimal` or `aggressive`. |
| `SYNESIS_YARN_CONTEXT_BUDGET_CEILING_TOKENS` | `0` | Manual context ceiling override. |
| `SYNESIS_YARN_CONTEXT_BUDGET_OUTPUT_RESERVE` | `10000` | Output token reserve. |
| `SYNESIS_YARN_CONTEXT_ADMISSION_WARN_TOKENS` | `200000` | Warning threshold. |
| `SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS` | `262000` | Hard admission threshold. |

## Prefix Stability

Prefix stability is the main path to provider-side KV/prefix cache wins. Yarn
does not assume provider cache behavior is generous. It makes the request shape
deterministic and then measures whether providers actually report cached tokens.

Mechanisms:

| Mechanism | Main modules | Stable component |
|-----------|--------------|------------------|
| BlockStore | `src/store/block-store.ts` | Reuses exact stable prompt block strings by SHA-256 of NFC-normalized content. |
| Prompt frame | `src/context/prompt-frame.ts` | Separates stable instructions, project state, volatile state, task frame, and governance blocks. |
| Stable prefix | `src/context/stable-prefix.ts` | Keeps durable system/developer content in a predictable order. |
| Sorted tools | `src/compat/sorted-tools.ts` | Canonicalizes tool schemas and JSON key ordering. |
| Prefix optimizer | `src/providers/prefix-optimizer/` | Places stable blocks before volatile blocks and applies provider cache markers when safe. |
| Provider cache hints | `src/context/provider-cache-hints.ts` | Computes prefix fingerprints and cache breakpoints. |
| Historical normalizer | `src/reduction/historical-normalizer.ts` | Stabilizes old transcript bytes that should not matter semantically anymore. |
| Route transcript stabilization | `src/pipeline/openai-route-transcript-stabilization.ts` | Applies route-local transcript stabilization before provider prep. |

The expected stable region is:

```text
stable instructions / durable system context
  + canonical tool schema
  + normalized historical transcript prefix
  + stable provider/cache policy
```

The expected volatile tail is:

```text
latest user request
  + live environment context
  + active task ledger
  + recent tool state
  + provider runtime details that genuinely changed
```

If a cache hit rate is low, first compare these hashes across turns:

- `stablePrefixHash`
- `toolSchemaHash`
- `providerOptionsHash`
- `normalizedTranscriptPrefixHash`
- `cachePolicyHash`
- `modelProviderResolutionHash`

Those fields come from `src/telemetry/cache-shape-diagnostics.ts` and are stored
on the optimization ledger.

## Provider Cache Behavior

Different providers expose cache behavior differently:

| Provider/runtime | Cache behavior | Yarn strategy |
|------------------|----------------|---------------|
| Anthropic-style APIs | Automatic or explicit prefix cache markers | Stable prefix plus deterministic marker placement where supported. |
| DashScope-style APIs | Explicit cache marker behavior and provider-specific minimums | Endpoint capability detection plus marker placement only when the stable block is large enough. |
| vLLM/SGLang/local serving | KV reuse depends on serving/runtime implementation | Byte-stable early payload, deterministic tool schemas, and stable provider options. |
| OpenRouter/aggregators | Varies by routed provider | Treat reported cache behavior as empirical, not guaranteed. |
| Unknown providers | Unknown | Preserve stable prefix and observe usage fields without assuming hits. |

The core rule is: **provider-advertised cache does not equal measured cache
savings**. Yarn records both request-shape hashes and provider usage fields so
we can separate our own prefix churn from upstream cache policy.

Related code:

- `src/telemetry/usage-normalization.ts`
- `src/providers/usage-telemetry-fetch.ts`
- `src/telemetry/provider-cache-canary.ts`
- `src/telemetry/cache-policy-controller.ts`
- `src/state/persistence-token-economics.ts`

See also `docs/CACHING.md` for provider-specific cache notes.

## Model Architecture Mediation

Token efficiency and cache reliability are affected by model architecture. A
model with a huge declared context window may still have weak long-tail recall,
sliding-window truncation behavior, attention compression tradeoffs, MoE routing
variance, or brittle tool-call boundaries.

`src/providers/model-architecture-profile.ts` defines:

- `ModelArchitectureProfile`
- `ModelExecutionPolicy`
- attention architecture: `full_attention`, `sliding_window`, `mla`, `hybrid`, `unknown`
- activation architecture: `dense`, `moe`, `unknown`
- decoding architecture: `standard`, `mtp`, `speculative_friendly`, `unknown`
- recommendations such as memory stitching, front-loaded instructions, recent
  tool state replay, structured tool digests, shorter turns, explicit state
  headers, and deterministic validation.

This is an adaptive harness policy, not model magic. Yarn cannot change the
model's internals. It can change:

- effective working context ceiling
- safe instruction/tool-output budgets
- compaction preference
- whether to replay recent tool state
- whether to front-load durable instructions
- whether to prefer explicit state headers
- whether to validate stream/tool-call boundaries more strictly

Architecture policy is recorded on optimization cache diagnostics:

- `architectureAttention`
- `architectureActivation`
- `architectureDecoding`
- `executionPolicyHash`
- `effectiveContextCeilingTokens`
- `architecturePolicyReasons`

These fields make it possible to compare cache and quality behavior between,
for example, raw Qwen, MiniMax, DeepSeek-style MLA, Kimi-style MoE, and unknown
OpenAI-compatible models.

## Governor And Forward Momentum

The governor is intentionally adjacent to token optimization. It is not a token
reducer, but bad governor pauses waste tokens and destroy developer momentum.
After the refactor, governor work is mediated through:

- `src/governance/governor-service.ts`
- `src/governance/execution-governor.ts`
- `src/pipeline/openai-governed-stage.ts`
- `src/pipeline/openai-execution-governor-preparation.ts`
- `src/pipeline/openai-governance-precheck.ts`
- `src/pipeline/route-governance-blocks.ts`

Recent fixture additions specifically protect forward discovery and verification
momentum:

- dirty workspace discovery should not be mistaken for no-progress churn.
- first failing verification after an edit should be allowed.
- todo/task lifecycle boundaries should break verification-churn streaks.
- same-source rereads and repeated compile failures should still pause when
  they are genuine loops.

This matters for token efficiency because false pauses force users to retry,
restart, or rebuild context. The cheapest token is the one we never need because
the session continued correctly.

## Telemetry And Cache Debugging

`OptimizationLedger` records:

| Field group | Examples |
|-------------|----------|
| Input size | `inputCharsOriginal`, `inputCharsAfterReduction`, `inputCharsAfterPruning`, `inputCharsAfterDedup`, `inputCharsAfterNormalization`, `inputCharsFinal` |
| Reduction hits | `toolResultsOriginalChars`, `toolResultsReducedChars`, `responseDedupHits`, `contentDedupHits`, `blockStoreHits` |
| Stability metrics | `prefixStableBytes`, `jitterLinesExtracted`, `historicalNormReplacements`, `toolIdRewrites` |
| Timings | `stageTimingsMs.ingress`, `normalization`, `pruning`, `context`, `governor`, `enrichment`, `provider_request`, `provider`, `stream`, `persistence` |
| Provider cache usage | `upstreamCachedTokens`, normalized prompt/cache creation tokens when available |
| Cache shape | stable prefix, tool schema, provider options, transcript prefix, cache policy, and model/provider resolution hashes |
| Architecture policy | attention/activation/decoding classes, execution policy hash, effective context ceiling, policy reasons |

Debug checklist for low cache rates:

1. Compare `stablePrefixHash` turn-to-turn. If it changes, inspect system block
   ordering, enrichment blocks, and model architecture hints.
2. Compare `toolSchemaHash`. Tool order, descriptions, or dynamic schema fields
   often destroy cache reuse.
3. Compare `providerOptionsHash`. Temperature, max tokens, model aliases,
   stream flags, cache flags, and provider-specific options should be stable.
4. Compare `normalizedTranscriptPrefixHash`. If it churns, look at historical
   normalization, tool-call IDs, timestamps, cwd, session ids, and repeated read
   output.
5. Compare `cachePolicyHash`. Cache policy mutation should be explainable by
   provider capability, route mode, or architecture policy.
6. Compare `modelProviderResolutionHash`. Provider/model routing drift changes
   cache domains.
7. Check `cacheShapeHitPct` and `cacheShapeOutcome`. If our hashes are stable
   but provider cached tokens stay zero, the upstream provider may not be
   honoring cache for that request shape.
8. Check stage timings. If optimization latency rises without token/cache wins,
   reduce or disable that stage for the relevant mode/profile.

## Persistence And Token Economics

Persistence is now factored out of the route body:

| Concern | Main modules |
|---------|--------------|
| Session usage persistence | `src/state/session-usage-persistence.ts` |
| Persistence orchestration | `src/state/session-persistence-runner.ts` |
| Route persistence scope | `src/state/route-persistence-scope.ts` |
| Token economics | `src/state/persistence-token-economics.ts`, `src/telemetry/token-economics.ts` |
| Usage writing | `src/state/usage-writer.ts` |
| Decision telemetry | `src/state/decision-telemetry-persister.ts` |

Token economics normalizes:

- input/output token counts
- cached/cache-creation tokens
- provider pricing source
- cost estimates
- cache policy observation
- provider cache reporting

This separation is important because provider execution should not know how
accounting is stored, and storage should not decide how provider requests are
constructed.

## State Locations

| Data | Location | Lifetime |
|------|----------|----------|
| Live conversation/session state | In-memory session maps and helpers | Process lifetime |
| Persisted session state | Redis via `src/state/session-store.ts` | Session TTL |
| Session event ledger | Redis/Postgres event paths via `src/state/session-event-store.ts` and route event emitters | TTL/permanent depending sink |
| Usage rows | Postgres `yarn_usage_log` | Permanent |
| Session events | Postgres `yarn_session_events` | Permanent |
| File summaries and continuity | Redis/local stores | Session TTL |
| Structural index/content dedup | Per-session memory | Process lifetime |
| BlockStore prompt blocks | In-memory global LRU | Process lifetime |
| Artifacts | `src/state/artifact-store.ts` | TTL-bound |

## Validation Lanes

Token optimization is validated through multiple lanes:

| Lane | Purpose |
|------|---------|
| Unit tests | Deterministic behavior for reducers, prefix hashes, architecture profiles, request prep, stream components, and persistence helpers. |
| Governor replay fixtures | Offline contracts for false-positive/false-negative governor behavior. |
| Eval Gym | OpenAI-compatible multi-turn scenarios with simulated tools. |
| Eval Client Lab | API-level sweeps of eval-gym scenarios across client profiles such as raw OpenAI, OpenCode, Claude Code, Codex CLI, and Cursor. |
| Harness Lab | Real lower-harness subprocess runs in disposable workspaces, with stdout/stderr risk scoring and fixture drafts. |
| Cache canaries | Controlled experiments for provider cache reporting and cache-shape stability. |

Relevant docs and scripts:

- `docs/governor-behavior-validation.md`
- `docs/CACHING.md`
- `scripts/eval-gym.ts`
- `scripts/eval-client-lab.ts`
- `scripts/harness-lab.ts`
- `scripts/cache-canary.ts`

## Feature Flags

Critical flags and defaults:

| Flag | Default | Category |
|------|---------|----------|
| `SYNESIS_YARN_REDUCERS_ENABLED` | `true` | Reduction |
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_ENABLED` | `true` | Pruning |
| `SYNESIS_YARN_DEDUPE_ENABLED` | `true` | Dedup |
| `SYNESIS_YARN_TOOL_PREFIX_CACHE_ENABLED` | `true` | Caching |
| `SYNESIS_YARN_PREFIX_OPTIMIZER_ENABLED` | `true` | KV stability |
| `SYNESIS_YARN_STABLE_PREFIX_ENABLED` | `true` | KV stability |
| `SYNESIS_YARN_JITTER_BUFFER_ENABLED` | `true` | KV stability |
| `SYNESIS_YARN_SORTED_TOOLS_ENABLED` | `true` | KV stability |
| `SYNESIS_YARN_JSON_COMPACTION_ENABLED` | `true` | Reduction |
| `SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED` | `true` | Quality |
| `SYNESIS_YARN_STRUCTURAL_INDEX_ENABLED` | `true` | Context |
| `SYNESIS_YARN_CONTENT_DISPATCH_ENABLED` | `true` | Reduction |
| `SYNESIS_YARN_HISTORICAL_CONTENT_NORMALIZE_ENABLED` | `true` | KV stability |
| `SYNESIS_YARN_CONTEXT_BUDGET_ENABLED` | `true` | Compaction |
| `SYNESIS_YARN_CONTEXT_BUDGET_COMPACTION_MODE` | `minimal` | Compaction |
| `SYNESIS_YARN_TOOL_COLLAPSE_ENABLED` | `false` | Batching |
| `SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED` | `false` | Memory |

## What To Optimize Next

The refactor made token efficiency easier to reason about. The next high-value
work should be measured, not guessed:

1. **Cache-shape dashboards.** Surface stable prefix/tool/provider/transcript
   hash churn and provider cache hit/write/miss outcomes in the admin UI.
2. **Provider A/B runs.** Use Eval Client Lab and cache canaries to compare raw,
   compat, optimized, and governed modes against the same scenario corpus.
3. **Architecture-policy experiments.** Compare model architecture profiles with
   mediation `observe` vs `adapt` for MiniMax, Qwen, DeepSeek-style MLA, Kimi,
   and unknown OpenAI-compatible models.
4. **Tool schema stability gate.** Add a CI or nightly check that hashes canonical
   tool schemas across representative clients and flags unexpected churn.
5. **Prefix diff inspector.** Build an admin view that shows the first changed
   stable-prefix segment between two turns.
6. **Economics scorecard.** Combine token savings, provider cached tokens,
   latency, governor pauses, and completion KPI into one release scorecard.

The target state is not “maximum compression.” It is the highest reliable
developer throughput per dollar: stable prefixes, small high-signal context,
few false governor pauses, and enough observability to prove where cache wins
and misses are coming from.
