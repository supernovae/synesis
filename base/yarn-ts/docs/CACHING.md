# Caching, prefix stability, and provider shims in Yarn (yarn-ts)

This document is the **authoritative** description of how Synesis Coder (the `synesis-yarn-ts` service) reasons about **prefix / KV cache**, **pluggable "explicit" cache** hooks, and **optional provider shims** (including DashScope-style backends). It is updated together with the code in this directory.

## Goals

- **Maximize** stable-prefix reuse (implicit KV cache) for OpenAI-compatible `POST` bodies.
- **Never** contort the core request pipeline around a single vendor. Provider specifics live in the provider layer, adapter metadata, and optional shims.
- **Observe** what actually hits: if a vendor claims "tiered" or "id" cache but your metrics show **no effective hit rate**, treat the integration as **experimental** until proven.

## Implicit prefix (default path)

- **OpenRouter, vLLM, and many hosts** benefit from a **byte-stable** early prefix. Yarn structures prompts via a `PromptFrame` and interned blocks (`BlockStore`, `computeVolatileFingerprint` in [prompt-frame.ts](../src/context/prompt-frame.ts), [index.ts](../src/index.ts)).
- **What breaks cache**: shuffling system blocks, nondeterministic tool JSON ordering, unbounded volatile material early in the prefix, and frequent edits to the same system block.
- **Observability**: `computePrefixFingerprint` in [provider-cache-hints.ts](../src/context/provider-cache-hints.ts) and request forensics in production metrics help spot drift.

## Explicit / "tiered" cache — pluggable, not guaranteed

- Some vendors offer **marker-based** or **id-based** cache reporting on responses. Yarn exposes provider-scoped marker hooks where they are useful, but the default OpenAI-shaped route does not attach markers globally. That is an intentional tradeoff, not a TODO left open by mistake.
- **Historical note**: an integration that mapped a vendor's **tiered / id** cache fields to our telemetry showed **no useful hit rate** in practice. Do not assume "vendor says cache" means **measurable** savings until `cached_tokens` / hit metrics move in a controlled experiment.

### Deterministic breakpoint strategy (Anthropic explicit)

When `detectCacheStrategy` returns `anthropic_explicit`, `annotateCacheBreakpoints` places up to **three** `cache_control: { type: "ephemeral" }` markers at fixed, deterministic positions:

| Breakpoint | Position | Stability |
|------------|----------|-----------|
| **BP1** | End of the leading system-message prefix (system prompt + tool definitions) | Static — changes only on tool schema updates |
| **BP2** | `messages.length - VOLATILE_TAIL_SIZE - 1` (end of the epoch-frozen stable history) | Stable — moves only on epoch re-anchor (every N turns) |
| **BP3** *(optional)* | Midpoint of the volatile tail, when tail exceeds ~10 k estimated tokens | Semi-stable — shifts each turn but provides partial reuse on retries |

The key insight: new messages only append to the tail.  Everything before **BP2** is identical turn-over-turn, giving the KV cache a byte-stable prefix to match.  BP2 only shifts when the epoch re-anchors (controlled by `SYNESIS_YARN_SCOPE_EPOCH_INTERVAL`, default 10 turns).

`VOLATILE_TAIL_SIZE` is set to **20** (the recent keep-window).  If the conversation is too short for BP2 or it would overlap BP1, it is omitted.

### Supporting mechanisms for prefix stability

| Mechanism | File | Purpose |
|-----------|------|---------|
| **Epoch-based sticky boundary** | `governance/objective-scope.ts` | Freezes the pruning boundary for N turns via `PruningCheckpoint` — prevents the boundary from shifting every request |
| **Content-hash tool call IDs** | `reduction/historical-normalizer.ts` | Rewrites tool call IDs to `tc_{sha256hex}` — stable even when earlier messages are pruned |
| **Governor guidance tail-append** | `index.ts` | Recovery/sensemaking system messages are pushed to the end instead of spliced into the middle |
| **Snap-to-grid pruning** | `governance/objective-scope.ts`, `governance/context-budget-manager.ts` | Message counts snap to bucket multiples (50) to reduce boundary variation |

**Debug checklist when a vendor advertises cache**

1. Confirm **prefix bytes** are stable (fingerprints, first-changed system section in forensics).
2. Confirm the **right route** (OpenAI vs native Anthropic SDK) is used for that vendor's feature.
3. Compare **input token growth** per turn vs. expected cache discount.
4. Check that BP2 position is not shifting every turn — verify `SYNESIS_YARN_SCOPE_EPOCH_INTERVAL` is set.

## DashScope explicit cache (provider adapter)

- **DashScope**-style backends are optional **inference** targets, like any other `baseUrl` in the model registry. They are **not** architectural requirements of Yarn.
- Production DashScope markers live in the **endpoint adapter** layer ([dashscope.ts](../src/providers/endpoint-capabilities/dashscope.ts)), not in the core enrichment pipeline.
- Enable with `SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MODE=canary` or `auto`. The default is `off`.
- `canary` uses `SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_CANARY_PCT` and a deterministic session hash so a session remains consistently in or out of the experiment.
- Markers are only applied when `resolveEndpointCapabilityId()` detects a DashScope URL and the prefix optimizer produced marker candidates for that session.
- The endpoint adapter places the marker on the **actual outbound leading-system boundary** after AI SDK/provider transforms, then adds a tool-schema marker when tools are present.
- Prefixes below the provider's minimum estimated cache size are left unmarked.

The legacy [dashscope-cache-interceptor.ts](../src/providers/dashscope-cache-interceptor.ts) remains as a lower-level repro/test helper; production routing uses endpoint capabilities.

## Optional Redis layers (multi-replica)

- **Artifacts**: `SYNESIS_YARN_ARTIFACT_REDIS_REPLICA_ENABLED` replicates `ArtifactRecord` JSON to Redis under `yarn-ts:artrep:{id}` so `synesis_artifact_retrieve` can resolve on a **different** pod than the one that created the handle.
- **Tool blob tier**: `RedisToolBlobTier` ([redis-tool-blob-tier.ts](../src/state/redis-tool-blob-tier.ts), `createToolBlobTier` in [tool-blob-tier.ts](../src/state/tool-blob-tier.ts)) stores large UTF-8 blobs in Redis. `UnimplementedObjectStoreBlobTier` is a deliberate placeholder for a future S3/HTTP object tier with the same interface.
- **Hierarchical summaries**: `HierarchicalSummaryStore` keys may include a **session scope**; use [createHierarchicalSummaryStore](../src/memory/summary-store.ts) so Redis keys are not shared across sessions.

## Sensemaking and volatile system blocks

- `SYNESIS_YARN_SENSEMAKING_ENABLED` controls gap classification, trigger evaluation, and telemetry.
- `SYNESIS_YARN_SENSEMAKING_PROMPT_BLOCK_ENABLED` controls whether a triggered run appends the late **`<EXPLORATION_PLAN>`** block.
- Safe default: keep prompt-block injection off and enable classification first. Turn prompt blocks on only after validating cache hit-rate impact in your target workload.

## Related files

- [REQUEST_PIPELINE_MAP.md](../REQUEST_PIPELINE_MAP.md) — end-to-end production path
- [provider-cache-hints.ts](../src/context/provider-cache-hints.ts) — `annotateCacheBreakpoints`, `computePrefixFingerprint`, `VOLATILE_TAIL_SIZE`
- [synesis-provider.ts](../src/providers/synesis-provider.ts) — model resolution, compatibility options
- [prefix-optimizer/](../src/providers/prefix-optimizer/) — client metadata and marker policy
