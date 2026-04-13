# Planner TS (Bootstrap)

This service is the TypeScript migration target for the planner runtime.

## Current scope

- OpenAI-compatible API skeleton:
  - `GET /health`
  - `GET /v1/models`
  - `POST /v1/chat/completions` (stream + non-stream)
- Canonical pipeline scaffold:
  - `entry_pipeline -> planner -> plan_gate -> router -> writer -> critic -> final_scrubber -> respond`
- Typed contracts (`zod`) for core planner artifacts.
- Reducer parity primitives for:
  - evidence packet merge
  - set-once dict fields
  - append-only ledgers
  - critique lifecycle merge/reopen semantics
- Deterministic context optimization (Yarn-derived):
  - oversized payload reduction envelopes
  - LITM-inspired message ordering
  - recent-history admission bounds
- Router-governed evidence bootstrap:
  - typed router node with evidence packet parsing + fallback assembly
  - retrieval client boundary isolated under `src/retrieval/`
  - governance tests that enforce router-only retrieval imports
- Critic/anti-oscillation bootstrap:
  - oscillation scoring module with weighted dimensions
  - critic route policy parity (`need_more_evidence -> router`, bounded revision loops)
  - tests covering drift/override and routing outcomes
- Deterministic contract validators bootstrap:
  - style compliance, decision drift, citation preservation checks
  - draft fingerprinting and critique-register annotation helpers
  - pipeline integration so critic approval reflects deterministic validation
- Validated-node wrapper parity:
  - generic pre/post validator hooks (`validatedNode`)
  - pre-violation warning injection into node context
  - post-violation annotation and critic-state adjustment
- Golden replay harness:
  - JSON fixtures under `tests/fixtures/golden/`
  - replay tests asserting contract-level outcomes for representative scenarios
  - includes baseline scenarios for happy path, citation gaps, decision drift, and oscillation pressure
  - baseline corpus for ongoing TS-only regression expansion
- LangGraph.js execution path:
  - `invokeGraph()` now runs a compiled `StateGraph` (entry -> planner -> plan_gate -> router -> writer -> critic -> scrubber/respond)
  - conditional routing mirrors current TS pipeline decisions
  - parity test ensures graph invocation stays aligned with canonical pipeline output
- Writer/Critic behavior bootstrap:
  - writer now composes structured draft sections from plan + evidence packets
  - critic evaluator emits typed `CriticOut` (deterministic path + optional raw JSON parse/repair)
  - critic decisions now include scores, blocking/nonblocking issues, and repair instructions
- Optional LLM path (env-gated, deterministic fallback preserved):
  - `SYNESIS_PLANNER_TS_LLM_ENABLED=true` + `SYNESIS_PLANNER_TS_LLM_BASE_URL` enables OpenAI-compatible calls
  - writer model via `SYNESIS_PLANNER_TS_WRITER_MODEL`
  - critic model via `SYNESIS_PLANNER_TS_CRITIC_MODEL`
  - on LLM errors/timeouts, writer/critic fall back to deterministic logic
- SSE decoupling and cleanup:
  - centralized SSE writer helpers in `src/streaming/sse.ts`
  - phase mapping + content chunking in `src/streaming/phases.ts`
  - streaming now emits node-trace phase events and chunked content deltas via a consistent event envelope
- API decoupling:
  - Fastify app construction moved to `src/app.ts` (`buildApp(config)`)
  - `src/index.ts` is now a thin runtime bootstrap wrapper
  - API compatibility tests validate non-stream envelope, bearer-auth behavior, and SSE output contract
- Verification/perf gate artifacts:
  - `tests/sse-conformance.test.ts` validates SSE status/event/chunk semantics
  - `tests/latency-budget.test.ts` validates local p50/p95 latency budgets for stream + non-stream
  - `npm run bun:smoke` runs Bun compatibility smoke checks (`typecheck`, `test`) and skips cleanly when Bun is not installed
  - `npm run verify:gates` runs consolidated cutover gates (typecheck, tests, Bun smoke)
- Cutover/rollback artifacts:
  - `CUTOVER_ROLLBACK_RUNBOOK.md` defines staged promotion + immediate fallback procedure
  - `STAGING_REHEARSAL_CHECKLIST.md` provides a sign-off checklist for staging promotion/rollback rehearsal
  - `STAGING_REHEARSAL_RECORD_TEMPLATE.json` provides a machine-readable rehearsal record format for archival/automation
  - `npm run rehearsal:new` scaffolds a timestamped rehearsal record JSON from the template
- Auth/RBAC hardening bootstrap:
  - explicit `AuthContext` resolution in `src/auth/resolver.ts` (token mode + forwarded identity trust boundary)
  - scoped authorization gate in `src/auth/authorizer.ts` for chat-completions access
  - OpenFGA-backed policy engine in `src/auth/policy-engine.ts` for centralized authorization checks
  - strict forwarded-header mode for service-to-service identity propagation
  - per-request authz decision trace headers (`x-synesis-authz-trace-id`, `x-synesis-authz-engine`, `x-synesis-authz-rules`)
  - authz counters + recent decision events exposed via `/health` (`auth.policyStats`)
  - dedicated authz event feed available at `/health/authz-events`
  - structured allow/deny authz logs include trace ID + matched rules
  - graph state stores authz metadata (`authz_trace_id`, `authz_engine`, `authz_rules`) for downstream correlation
  - node traces and decision ledger rationale carry `authz_trace_id` for orchestration-to-authz lineage
  - API tests cover missing bearer, missing model scope, untrusted forwarded identity, and trusted service-token forwarding
  - OpenFGA rollout design documented in `OPENFGA_AUTHZ_DESIGN.md` with shared tuple model and staged enforcement plan
- Session continuity + sawtooth-style checkpointing:
  - `src/context/session-manager.ts` provides per-conversation history, checkpoint summaries, and TTL pruning
  - incoming requests can be enriched with compact `<SESSION_STATE>` blocks for long chats
  - health telemetry now includes session counters (active, checkpointed, history entries)
- Capability lock assertions to prevent regression during migration.

## Migration invariants

The TS migration must preserve or improve:

- anti-oscillation controls
- router-governed evidence boundary
- deterministic structured repair
- decision ledger and critique lifecycle semantics
- security/trust boundaries
- client-neutral policy behavior

## Next steps

1. Expand writer/critic prompt + schema parity from captured Python traces.
2. Add broader performance/conformance gates (SSE cadence, latency/error budgets, Bun smoke).
3. Stage cutover/rollback manifests for big-bang switch with Python fallback.
