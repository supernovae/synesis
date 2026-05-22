# Yarn token economics hardening

This note documents the first token-economics hardening slice for `base/yarn-ts`.
The goal is to make provider-cache behavior observable before Synesis makes
more aggressive compaction or premium-cache decisions.

## What changed

Yarn now builds a normalized token-economics decision for provider calls. The
decision records:

- provider cache strategy: explicit premium, explicit ephemeral, implicit prefix, reported-only, none, or unknown
- provider usage: prompt tokens, output tokens, cached prompt tokens, and cache-creation tokens
- cache outcome: hit, write without read, miss, or no usage
- recommendation: cache healthy, disable premium cache write, preserve stable prefix and investigate, observe more, or telemetry missing
- compaction context when available: stable prefix bytes and estimated tokens saved

Primary implementation:

- `base/yarn-ts/src/telemetry/token-economics.ts`
- `base/yarn-ts/src/telemetry/cache-policy-controller.ts`
- `base/yarn-ts/src/providers/usage-telemetry-fetch.ts`
- `base/yarn-ts/src/providers/endpoint-capabilities/dashscope.ts`
- `base/yarn-ts/src/index.ts`
- `packages/synesis-telemetry/src/usage-extract.ts`

## Runtime behavior

### Streaming and non-streaming usage

`createUsageTelemetryFetch` now inspects both streaming SSE usage events and
non-streaming JSON responses. Both paths emit `llm_usage_telemetry` with a
`token_economics` object, so cache behavior is comparable across client
harnesses and response modes.

The wrapper preserves upstream responses:

- streaming responses are still tee'd, with diagnostics read from the secondary stream
- non-streaming JSON is read, logged when usage is present, then returned with the original body text
- malformed JSON and non-JSON responses pass through without telemetry mutation

### DashScope premium cache safety

DashScope explicit cache markers are still gated by mode (`off`, `canary`,
`auto`) and the prefix optimizer. When explicit markers are applied, Yarn logs:

- `dashscope_explicit_cache_markers_applied`
- marker count and marker indices
- stable system prefix token estimate
- `cache_strategy: explicit_premium`
- `recommendation: observe_provider_cache_hits`

When markers are skipped, Yarn logs `dashscope_explicit_cache_decision` with a
skip reason such as:

- `max_markers_zero`
- `no_stable_system_prefix`
- `optimizer_marker_missing`
- `stable_prefix_below_min_tokens`
- `marker_validation_failed`

This keeps premium cache writes auditable and makes it easier to detect cases
where cache creation is happening without downstream cache reads.

### Cache Policy Controller

The Cache Policy Controller consumes the previous turn's token-economics state
from session metadata and chooses the next request's cache/efficiency posture:

- `preserve_cache`: provider cache hits were observed, so Yarn uses minimal
  compaction and protects stable prefixes.
- `safe_efficiency`: cache is unavailable, unreported, or repeatedly missing,
  and the agent flow is stable, so Yarn may use aggressive context-budget
  compaction to reduce token demand.
- `safety_backoff`: cache is unavailable but the agent shows retry-loop or
  comprehension-risk signals, so Yarn falls back to minimal compaction to avoid
  making the model's recovery context harder to understand.
- `observe`: insufficient signal or controller disabled; use configured
  compaction behavior.

Retry-loop/comprehension risk is inferred from existing session counters:

- stagnant tool cycles
- pending tool-loop acknowledgement
- no-ack tool-loop count
- recent recovery fires
- repeated edit-context misses

For explicit premium cache providers such as DashScope, repeated cache writes
without reads suppress explicit cache markers for that session. This avoids
paying for cache creation when the host is not producing useful hits.

Controller knobs:

- `SYNESIS_YARN_CACHE_POLICY_CONTROLLER_ENABLED` default `true`
- `SYNESIS_YARN_CACHE_POLICY_MISS_STREAK_THRESHOLD` default `2`
- `SYNESIS_YARN_CACHE_POLICY_TELEMETRY_MISSING_THRESHOLD` default `2`
- `SYNESIS_YARN_CACHE_POLICY_PREMIUM_WRITE_STREAK_THRESHOLD` default `2`
- `SYNESIS_YARN_CACHE_POLICY_RETRY_RISK_STAGNANT_CYCLES` default `2`

### Durable trace and session visibility

`persistSessionAndUsage` now records the token-economics summary in:

- session metadata: last cache-hit ratio, last recommendation, last warnings
- cache-policy streak metadata: cache misses, cache hits, premium writes without reads, telemetry misses
- `request_trajectory_v1.cost.token_economics`
- trace context: `trace_context.token_economics`
- warning session events: `token_economics_warning_v1`
- controller session events: `cache_policy_controller_decision_v1`

This gives the admin/control-plane side queryable signals before adding a
dedicated dashboard view or database migration.

### Retry visibility

The endpoint transport retry wrapper now logs final retry exhaustion and final
request failure. These logs include provider, attempt count, status/error, and
whether the request was replay-safe.

## Cache-first policy

The current policy is intentionally conservative:

- If provider cache hits are reported, treat the cache as healthy.
- If DashScope-style premium cache creation happens without reads, recommend
  disabling or downgrading premium cache writes for that provider/client pair.
- If prompt tokens are high but cache hits are absent, preserve stable prefixes
  and investigate before making compaction more aggressive.
- If usage telemetry is missing, mark the packet as telemetry missing instead
  of assuming savings.

This matches the operating principle: if Synesis cannot prove compaction reduces
net cost for a provider and harness, it should bias toward preserving cache
efficiency and developer flow.

## Validation

Focused test command:

```bash
cd base/yarn-ts
npm run test:token-economics
```

This runs:

- `tests/token-economics.test.ts`
- `tests/cache-policy-controller.test.ts`
- `tests/usage-telemetry-fetch.test.ts`
- `tests/dashscope-endpoint-adapter.test.ts`

Recommended pre-merge checks for this slice:

```bash
cd packages/synesis-telemetry
npm run typecheck
npm run build

cd ../../base/yarn-ts
npm run typecheck
npm run build
npm run test:token-economics
```

## Next hardening steps

- Add admin dashboard rollups for `token_economics_warning_v1` and poor cache-hit cohorts.
- Add live canaries for Anthropic, DashScope, OpenAI-compatible, DeepSeek/OpenRouter, and vLLM routes.
- Feed longer-window observed hit rates back into provider policy so the controller can make org/provider-level decisions, not only per-session decisions.
- Add golden packet fixtures for Claude Code, Codex, Roo, Windsurf, VS Code, OpenCode, Hermes/Claw-style, and generic OpenAI-compatible harnesses.
- Extend cost gates so CI can block regressions in stable-prefix length, cache-marker placement, cached-token reporting, and compaction economics.
