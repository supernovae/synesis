# Python vs TypeScript Planner Feature Gap Tracker

Working document to track parity between `base/planner` (Python) and `base/planner-ts` (TypeScript), and decide what to implement next vs intentionally keep different.

## Scope and intent

- Compare runtime behavior and operational features, not only type/schema parity.
- Mark each item as:
  - `parity` (implemented in TS with equivalent behavior),
  - `partial` (implemented but materially different),
  - `missing` (not present in TS today).
- Use this as a decision log for follow-up implementation.

## Current parity snapshot

### Core planner graph and governance

- `parity` LangGraph node pipeline exists in TS (`entry_pipeline -> planner -> plan_gate -> router -> writer -> critic/final_scrubber -> respond`).
  - Python: `base/planner/app/graph.py`
  - TS: `base/planner-ts/src/graph.ts`
- `parity` deterministic gates/validators exist (plan gate, contract validation, oscillation routing).
  - Python: `base/planner/app/nodes/*`, `base/planner/app/graph.py`
  - TS: `base/planner-ts/src/nodes/plan-gate.ts`, `contract-validator.ts`, `oscillation-detector.ts`
- `parity` critic background mode exists.
  - Python: `base/planner/app/config.py` (`critic_background`), graph routing
  - TS: `base/planner-ts/src/config.ts` + `graph.ts` + background critic spawn in `app.ts`
- `parity` model tier surface exists (`Auto/Pulse/Core/Horizon` list and request mapping).
  - Python: model normalization path in `main.py`
  - TS: `base/planner-ts/src/model-tiers.ts`, `app.ts`

### Complexity and effort routing

- `partial` TS has entry classification and effort routing, but simplified compared to Python scoring engine + taxonomy stack.
  - Python richer: `entry_pipeline.py`, `entry_classifier.py`, `effort_router.py`
  - TS simplified: `base/planner-ts/src/nodes/entry-classifier.ts`
- `partial` trivial/fast-path routing exists in TS, but does not yet include Python's deferred direct-stream fast path.
  - Python: writer `direct_stream_request` in `base/planner/app/nodes/writer.py`
  - TS: fast path to writer in classifier, but no direct stream transport path

## Key gaps (highest impact)

### 1) Provider-level prefix caching (decision: required)

- Status: `parity` — implemented in TS
- Implementation:
  - LLM client extracts real `cached_prompt_tokens` from provider responses (OpenAI `prompt_tokens_details.cached_tokens`, vLLM `cached_tokens`, LiteLLM passthrough).
  - Usage telemetry is surfaced in both stream and non-stream responses.
  - Config flag `SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE` controls policy (`auto`/`strict`/`disabled`).
  - Writer and critic accumulate `llm_usage` into `GraphState` across the pipeline.
  - evidence: `base/planner-ts/src/llm/client.ts`, `base/planner-ts/src/app.ts`, `base/planner-ts/src/pipeline.ts`

### 2) Streaming fidelity and granularity

- Status: `partial`
- Python behavior:
  - token-level stream from writer (`astream_events` and direct SDK stream path)
  - rich phase/sub-phase updates during execution
  - reasoning-content forwarding in streaming deltas for clients that support it
  - evidence: `base/planner/app/main.py`, `base/planner/app/streaming_events.py`
- TS behavior:
  - emits SSE status events (`data: {"event": ...}`), heartbeat while graph runs
  - currently sends response content after graph completion (chunked final payload), not token-by-token generation
  - evidence: `base/planner-ts/src/app.ts`, `base/planner-ts/src/streaming/sse.ts`

### 3) UI-helper and slash-command control plane

- Status: `missing` in TS
- Python behavior:
  - early filtering for UI helper prompts (`title`, `tags`, `follow_ups`)
  - `/why` and `/reclassify` command paths
  - evidence: `base/planner/app/main.py`, `base/planner/app/message_filter.py`
- TS behavior:
  - no equivalent early command/filter path in `app.ts`

### 4) Context pivot handling

- Status: `missing` in TS
- Python behavior:
  - language/domain/deliverable pivot detection
  - pivot summarization + memory flush/archive behavior
  - evidence: `base/planner/app/main.py`, `history_summarizer.py`, `conversation_memory.py`
- TS behavior:
  - session memory exists but no explicit pivot detector/summarizer pipeline
  - evidence: `base/planner-ts/src/context/session-manager.ts`

### 5) Observability/debug surface

- Status: `partial`
- Python behavior:
  - metrics and debug endpoints (`/metrics`, `/debug/cache-stats`, `/debug/sse-test`)
  - prompt cache metrics counters
  - evidence: `base/planner/app/main.py`, `api_metrics.py`
- TS behavior:
  - has `/health` and `/health/authz-events`
  - no cache/debug parity endpoints
  - evidence: `base/planner-ts/src/app.ts`

## Recently fixed TS regressions (already landed)

- Latest user message selection in follow-ups (prevent reusing stale prompt context).
- Internal scaffolding leak cleanup (`Plan/Evidence/Answer` style wrappers).
- Session memory sanitization for leaked planner/meta text.

Files:
- `base/planner-ts/src/app.ts`
- `base/planner-ts/src/pipeline.ts`
- `base/planner-ts/src/context/session-manager.ts`
- `base/planner-ts/src/nodes/writer-compose.ts`

## Caching and persistence decisions

### Prompt-level response caching

- Decision: `won't do` for TS parity.
- Reason:
  - low product value for repeated exact prompts.
  - can mask planner behavior while not reducing provider compute meaningfully in many cases.
  - provider-level prefix caching is the preferred optimization axis.
- Python note:
  - Python currently has prompt-response cache behavior in `main.py`; this is not a required TS parity target.

### Provider-level prefix caching

- Decision: `must do` — **implemented**.
- Policy:
  - prefix-caching-friendly message construction enforced (system + history prefix, current turn appended).
  - runtime telemetry surfaces real `cached_prompt_tokens` per response.
  - config: `SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE` (auto/strict/disabled).
- Implementation:
  - `base/planner-ts/src/llm/client.ts`: extracts cached token counts from OpenAI/vLLM/LiteLLM response formats.
  - `base/planner-ts/src/pipeline.ts`: accumulates `llm_usage` through writer and critic.
  - `base/planner-ts/src/app.ts`: surfaces accumulated usage in API responses.

### Redis usage policy

- Keep in Redis:
  - L1/L2 persisted session/history state.
- Avoid in Redis:
  - prompt-level response replay cache for end-user outputs.

## L1/L2 session state parity status

- Python status: `present`
  - session checkpointer supports Redis backend.
  - L2 archive path is Redis-backed when configured.
  - evidence: `base/planner/app/config.py`, `base/planner/app/main.py`, `base/planner/app/graph.py`
- TS status: `parity`
  - `SessionManager` uses a pluggable `SessionStore` interface with two backends:
    - `MemorySessionStore` (in-process `Map`, default/fallback).
    - `RedisSessionStore` (Redis with TTL, scoped keys, automatic expiration).
  - Backend selected by presence of `SYNESIS_PLANNER_TS_REDIS_URL` env var.
  - Purge API: `DELETE /v1/memory/:conversationId` for explicit lifecycle management.
  - evidence: `base/planner-ts/src/context/session-store.ts`, `base/planner-ts/src/context/session-manager.ts`, `base/planner-ts/src/app.ts`
  - docs: `docs/PLANNER_MEMORY_LIFECYCLE.md`

## Decision backlog (recommended order)

1. ~~Add TS provider-level prefix caching policy and capability-aware LLM request wiring.~~ **Done.** See `base/planner-ts/src/llm/client.ts`.
2. ~~Add TS Redis-backed L1/L2 session persistence (keep in-memory as fallback).~~ **Done.** See `base/planner-ts/src/context/session-store.ts`, `docs/PLANNER_MEMORY_LIFECYCLE.md`.
3. Add TS direct-stream fast path for trivial/easy-no-retrieval tasks.
4. Add TS UI-helper and slash-command pre-routing (`/why`, `/reclassify`, helper prompt filter).
5. Add TS pivot detection and controlled memory reset/summarization.
6. Add TS debug observability endpoints to match Python operational introspection.

## Intentional non-parity (do not port as-is)

Use this section to record behaviors we explicitly do not want to carry over 1:1.

Template:

- Feature:
  - Decision: `keep in Python` | `replace in TS` | `drop entirely`
  - Reason:
  - Risk if ported unchanged:
  - Owner:
  - Date:
  - Revisit trigger:

Seed candidates (editable):

- Feature: Prompt-response replay cache path
  - Decision: `drop entirely`
  - Reason: Prefer provider-level prefix caching over end-user response replay cache.
  - Risk if ported unchanged: stale/replayed responses, reduced behavioral transparency.
  - Owner: platform
  - Date: 2026-03-27
  - Revisit trigger: only if strict offline fallback requirements emerge.

- Feature: Python slash commands (`/why`, `/reclassify`) in production chat endpoint
  - Decision: `replace in TS`
  - Reason: Useful diagnostics, but should likely move behind explicit debug/admin mode in TS.
  - Risk if ported unchanged: User-facing command leakage and behavior ambiguity in normal chats.
  - Owner: platform
  - Date: 2026-03-27
  - Revisit trigger: demand for in-chat diagnostics from operators.

- Feature: Rich pivot summarization + history flush heuristics
  - Decision: `replace in TS`
  - Reason: Keep context hygiene, but simplify and make deterministic to avoid accidental resets.
  - Risk if ported unchanged: over-aggressive pivot resets can drop useful context.
  - Owner: planner
  - Date: 2026-03-27
  - Revisit trigger: measurable context-drift regressions in TS.

- Feature: Python debug endpoints exposed in app (`/debug/*`)
  - Decision: `replace in TS`
  - Reason: Keep observability, but prefer health/metrics-safe surface and role-gated diagnostics.
  - Risk if ported unchanged: operational endpoints may expose internals unintentionally.
  - Owner: platform
  - Date: 2026-03-27
  - Revisit trigger: need for parity during incident response.

- Feature: Writer direct-stream path implementation details
  - Decision: `replace in TS`
  - Reason: Keep the latency outcome, but implement in TS-native client/runtime style.
  - Risk if ported unchanged: brittle parity-by-copy and maintenance drift.
  - Owner: planner
  - Date: 2026-03-27
  - Revisit trigger: if TS easy-prompt latency remains above target.

## Notes for decision-making

- "No phases on cache hit" is expected if graph is intentionally skipped and response is immediate.
- Main UX target is:
  - cache hit => very fast response, no graph phases required,
  - non-cache flow => visible phase progression and low time-to-first-token.
