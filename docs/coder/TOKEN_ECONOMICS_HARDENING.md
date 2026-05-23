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

Yarn also aggregates provider cache observations into short-lived
org/provider/client windows. These windows let the controller distinguish a
single noisy session from a provider and harness combination that is
consistently returning cache hits, missing cache hits, or failing to report
usable cache telemetry. If the window shows known-good provider cache hits,
Yarn preserves stable prefixes. If the window shows enough misses, telemetry
gaps, or premium writes without reads, Yarn can pivot toward safe
token-efficiency mode unless the session is showing retry-loop or
comprehension-risk signals.

Controller knobs:

- `SYNESIS_YARN_CACHE_POLICY_CONTROLLER_ENABLED` default `true`
- `SYNESIS_YARN_CACHE_POLICY_MISS_STREAK_THRESHOLD` default `2`
- `SYNESIS_YARN_CACHE_POLICY_TELEMETRY_MISSING_THRESHOLD` default `2`
- `SYNESIS_YARN_CACHE_POLICY_PREMIUM_WRITE_STREAK_THRESHOLD` default `2`
- `SYNESIS_YARN_CACHE_POLICY_RETRY_RISK_STAGNANT_CYCLES` default `2`
- `SYNESIS_YARN_CACHE_POLICY_PROVIDER_WINDOW_HOURS` default `24`
- `SYNESIS_YARN_CACHE_POLICY_PROVIDER_WINDOW_MIN_REQUESTS` default `8`

### User runtime controls

Logged-in users can set runtime preferences from their account page. The admin
API proxies these settings to Yarn internal endpoints:

- `GET /api/v1/yarn/runtime-preferences`
- `PUT /api/v1/yarn/runtime-preferences`

Yarn stores the normalized preferences in Redis under a TTL, then applies them
to subsequent requests for that user. Supported controls:

- loop break mode: `standard`, `assertive`, or `hands_off`
- cache policy bias: `auto`, `cache_first`, `balanced`, or `efficiency_first`
- whether aggressive compaction is allowed when provider cache hits are absent
- an optional tool-loop soft-fail limit

This keeps the default policy protective while giving advanced users a way to
choose sharper loop breaking, cache-first behavior, or hands-off behavior when
Yarn cannot infer the right preference safely.

Runtime preference knobs:

- `SYNESIS_YARN_USER_RUNTIME_PREFERENCES_ENABLED` default `true`
- `SYNESIS_YARN_USER_RUNTIME_PREFERENCES_TTL_MS` default `2592000000`

### Hashed cache debug traces

Set `SYNESIS_YARN_CACHE_DEBUG_TRACE=hashed` to emit one hashed-only
`provider_cache_debug_trace` record for each provider request that returns
usage telemetry. The trace includes provider/model/client context, stable
prefix bytes, shared prefix bytes with the previous request in the same
session, first divergent message index, request/tool/message hashes, normalized
usage, cache hit percentage, and a cache miss reason. It does not log prompt
text, tool-result text, or payload excerpts.

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

The admin API now exposes `/api/v1/observability/cache/token-economics`, and
the admin Prefix Cache Performance page includes a Token economics controller
panel. The rollup is scoped by caller role/org and summarizes:

- request trajectory cache outcomes, recommendations, strategies, and average cache hit percentage
- token-economics warning events, including premium cache writes without reads
  and unproven compaction savings
- cache-policy controller actions, compaction mode pivots, provider strategies,
  retry-risk backoffs, cache-unavailable detections, and suppressed premium
  markers

This gives operators a direct signal when the proxy is preserving cache
efficiency, switching to safe efficiency because cache is unavailable or
unreported, or backing off compaction because the session shows retry-loop risk.

### Provider cache canaries

`base/yarn-ts` includes offline provider-cache canaries that can run in CI
without provider credentials or token spend:

```bash
cd base/yarn-ts
npm run verify:cache-canaries
```

The canaries build deterministic two-turn packets for Anthropic, DashScope,
generic OpenAI-compatible, OpenRouter, DeepSeek, and vLLM-style routes. They
verify:

- stable-prefix bytes stay high across turns
- Anthropic and DashScope explicit cache markers remain stable
- DashScope provider-facing payloads include message and tool `cache_control`
  annotations when explicit cache is enabled
- implicit-cache providers avoid explicit annotations while still preserving
  stable prefix ordering
- token-economics decisions classify cache hits as healthy, cache misses as
  cache-first investigations, and DashScope premium writes without reads as a
  premium-cache suppression signal

This is the CI-safe contract. Live provider canaries reuse the same packets but
are disabled unless the caller opts into cost-bearing upstream calls:

```bash
cd base/yarn-ts
SYNESIS_CACHE_CANARY_LIVE=1 \
SYNESIS_CACHE_CANARY_ACK_COST=1 \
SYNESIS_CACHE_CANARY_ALLOW=openrouter \
SYNESIS_CACHE_CANARY_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1 \
SYNESIS_CACHE_CANARY_OPENROUTER_API_KEY=... \
npm run verify:cache-canaries
```

To probe the currently configured provider before the built-in provider cases,
provide the `current` endpoint and allow-list it:

```bash
cd base/yarn-ts
SYNESIS_CACHE_CANARY_LIVE=1 \
SYNESIS_CACHE_CANARY_ACK_COST=1 \
SYNESIS_CACHE_CANARY_ALLOW=current \
SYNESIS_CACHE_CANARY_CURRENT_BASE_URL=https://provider.example/v1 \
SYNESIS_CACHE_CANARY_CURRENT_MODEL=my-model \
SYNESIS_CACHE_CANARY_CURRENT_API_KEY=... \
SYNESIS_CACHE_CANARY_CURRENT_PROVIDER_TAG=openrouter \
npm run verify:cache-canaries
```

Equivalent CLI flags:

```bash
npm run verify:cache-canaries -- --live --ack-cost --allow=openrouter
```

To publish a report for admin observability, add `--json` with the target path:

```bash
npm run verify:cache-canaries -- --json /var/lib/synesis/cache-canary-report.json
```

Live canaries skip providers that are not allow-listed or configured. They fail
on transport errors, and only fail cache misses when
`SYNESIS_CACHE_CANARY_REQUIRE_HIT=1` or `--require-cache-hit` is set. Otherwise
they report cache-hit uncertainty as warnings so operators can observe provider
behavior without accidentally blocking deployments because an upstream does not
report cache telemetry.

Admin observability can read the latest JSON report directly from disk:

```bash
SYNESIS_CACHE_CANARY_REPORT_PATH=/var/lib/synesis/cache-canary-report.json
SYNESIS_CACHE_CANARY_REPORT_STALE_HOURS=24
```

When that path is set, org admins can inspect the report through
`GET /api/v1/observability/cache/canary-report` and the Prefix Cache
Performance page. The admin surface treats missing reports, stale reports,
offline failures, live transport failures, all-skipped live probes, missing
provider usage telemetry, and unverified cache hits as operator-visible alerts.
Leaving `SYNESIS_CACHE_CANARY_REPORT_PATH` unset disables the feature cleanly and
shows a non-blocking "not configured" status.

The same test suite also runs golden-packet cache-stability checks over client
profile fixtures for Claude Code, Codex CLI, Cursor, Hermes/Claw-style agents,
homegrown OpenAI-compatible harnesses, OpenCode, Roo/OpenCode, VS Code, and
Windsurf. These checks prove that representative harness payloads keep
append-only stable prefixes, stable toolset hashes, and volatile environment
metadata outside the stable core hash.

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
- `tests/user-runtime-preferences.test.ts`
- `tests/usage-telemetry-fetch.test.ts`
- `tests/dashscope-endpoint-adapter.test.ts`
- `tests/provider-cache-canary.test.ts`
- `tests/golden-packet-cache-stability.test.ts`

Admin rollup test:

```bash
cd base/admin
PYTHONPATH=. uv run pytest tests/test_observability_token_economics.py -q
```

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

- Extend cost gates so CI can block regressions in stable-prefix length, cache-marker placement, cached-token reporting, and compaction economics.
