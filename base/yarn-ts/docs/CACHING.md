# Caching, prefix stability, and provider shims in Yarn (yarn-ts)

This document is the **authoritative** description of how Synesis Coder (the `synesis-yarn-ts` service) reasons about **prefix / KV cache**, **pluggable “explicit” cache** hooks, and **optional provider shims** (including DashScope-style backends). It is updated together with the code in this directory.

## Goals

- **Maximize** stable-prefix reuse (implicit KV cache) for OpenAI-compatible `POST` bodies.
- **Never** contort the core request pipeline around a single vendor. Provider specifics live in the provider layer, adapter metadata, and optional shims.
- **Observe** what actually hits: if a vendor claims “tiered” or “id” cache but your metrics show **no effective hit rate**, treat the integration as **experimental** until proven.

## Implicit prefix (default path)

- **OpenRouter, vLLM, and many hosts** benefit from a **byte-stable** early prefix. Yarn structures prompts via a `PromptFrame` and interned blocks (`BlockStore`, `computeVolatileFingerprint` in [prompt-frame.ts](../src/context/prompt-frame.ts), [index.ts](../src/index.ts)).
- **What breaks cache**: shuffling system blocks, nondeterministic tool JSON ordering, unbounded volatile material early in the prefix, and frequent edits to the same system block.
- **Observability**: `computePrefixFingerprint` in [provider-cache-hints.ts](../src/context/provider-cache-hints.ts) and request forensics in production metrics help spot drift.

## Explicit / “tiered” cache — pluggable, not guaranteed

- Some vendors offer **marker-based** or **id-based** cache reporting on responses. Yarn exposes a path for **Anthropic-style** `cache_control` in [annotateCacheBreakpoints](../src/context/provider-cache-hints.ts), but the **default OpenAI-shaped** route may **not** attach those markers. That is an **intentional** tradeoff, not a TODO left open by mistake.
- **Historical note**: an integration that mapped a vendor’s **tiered / id** cache fields to our telemetry showed **no useful hit rate** in practice. Do not assume “vendor says cache” means **measurable** savings until `cached_tokens` / hit metrics move in a controlled experiment.

**Debug checklist when a vendor advertises cache**

1. Confirm **prefix bytes** are stable (fingerprints, first-changed system section in forensics).
2. Confirm the **right route** (OpenAI vs native Anthropic SDK) is used for that vendor’s feature.
3. Compare **input token growth** per turn vs. expected cache discount.

## DashScope and similar providers (service-layer shim)

- **DashScope**-style backends are optional **inference** targets, like any other `baseUrl` in the model registry. They are **not** architectural requirements of Yarn.
- The repository may retain **test-only** or **shim** helpers (e.g. [dashscope-cache-interceptor.ts](../src/providers/dashscope-cache-interceptor.ts)) to reproduce a provider’s wire behavior. Production may pass a no-op or neutral cache options object where a legacy call signature remains for **compatibility** with `resolve()`.
- Re-introducing a full DashScope cache shim belongs in the **provider adapter** layer, not in the core enrichment pipeline.

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
- [provider-cache-hints.ts](../src/context/provider-cache-hints.ts) — `annotateCacheBreakpoints`, `computePrefixFingerprint`
- [synesis-provider.ts](../src/providers/synesis-provider.ts) — model resolution, compatibility options
- [prefix-optimizer/](../src/providers/prefix-optimizer/) — client metadata and marker policy
