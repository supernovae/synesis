# Planner TS Scaling and Production Plan

## Purpose

This document is the canonical implementation and operations guide for scaling `planner-ts` toward beta production with a target of **25-50+ concurrent users** and eventual deprecation of the Python planner runtime.

Design intent:
- Fix-forward only (no backward-compatibility shims).
- Prioritize reliability and observability under concurrent load.
- Keep parity and DRY alignment between `planner-ts` and `yarn-ts` where practical.
- Treat Redis/Postgres infrastructure provisioning as external to this document.

## Scope and non-goals

In scope:
- planner-ts request resilience and bounded execution.
- Multi-pod-safe runtime behavior for streamed and non-streamed requests.
- Admission control for fairness and overload protection.
- Health/readiness posture for production rollouts.
- Network policy hardening.
- OTEL consistency plan across planner/yarn/mcp surfaces.

Out of scope:
- Redis/Postgres cluster provisioning and HA topology.
- Python planner prompt/retrieval cache migration.

Explicit decision:
- **Won't do (for this effort): prompt-level and retrieval response caching in planner-ts.**
  - Rationale: low observed hit rate, referential-integrity risks, and evidence ambiguity when corpus changes over time.
  - Revisit only with a stronger provenance-safe cache contract.

## Current implementation status

Completed in planner-ts:
- LLM resilience:
  - Circuit breaker + retry/backoff in `base/planner-ts/src/llm/client.ts`.
  - Breaker module in `base/planner-ts/src/llm/circuit-breaker.ts`.
- Per-node timeout guard in `base/planner-ts/src/graph.ts`.
- Per-user sliding-window rate limiter:
  - `base/planner-ts/src/middleware/user-rate-limit.ts`
  - Enforced in `base/planner-ts/src/app.ts`.
- Streaming admission controller:
  - `base/planner-ts/src/middleware/stream-admission.ts`
  - Enforced in `base/planner-ts/src/app.ts` with deterministic release.
- Readiness split:
  - Liveness at `/health`
  - Dependency-aware readiness at `/health/readiness` in `base/planner-ts/src/app.ts`.
  - Deployment probe switched in `base/planner-ts/deployment.yaml`.
- Network policy tightening in `base/planner-ts/network-policy.yaml` (removed fail-open egress).
- Config knobs added in `base/planner-ts/src/config.ts`.
- Validation tests expanded in `base/planner-ts/tests/api-contract.test.ts`.

Outstanding:
- Multi-pod session write correctness under concurrent updates (CAS/transaction semantics).
- Memory-session hard cap when Redis is unavailable.
- HPA/PDB manifests for planner-ts.
- OTEL unification and context propagation across planner/yarn/mcp.
- Final 25/35/50 concurrency load testing and cutover gate.

## Phased execution plan

### Phase A: Runtime hardening (done)

Goal: prevent cascade failures and unbounded latency.

Delivered:
- circuit breaker + retries
- per-node timeout
- per-user rate limiting
- stream admission
- readiness/liveness split
- fail-closed network policy baseline

### Phase B: Scale hardening (next)

Goal: make multi-pod behavior reliable under 25-50+ load.

Work items:
- Implement session write conflict protection in:
  - `base/planner-ts/src/context/session-store.ts`
  - `base/planner-ts/src/context/session-manager.ts`
- Add explicit cap/eviction for memory fallback session store.
- Add HPA and PDB manifests under `base/planner-ts/` and wire in `kustomization.yaml`.
- Add load-test profile and execute 25/35/50 concurrent-user runs.

### Phase C: OTEL consistency track (parallel)

Goal: end-to-end traceability across planner/yarn/mcp/admin.

Work items:
- Create shared TS OTEL bootstrap in `packages/` and adopt in planner + yarn.
- Standardize trace context propagation:
  - `traceparent`
  - `x-request-id`
  - authz trace correlation IDs
- Align `trace_id`/`request_id` semantics in `packages/synesis-telemetry/src/types.ts`.
- Ensure MCP routes/proxies in yarn propagate correlation headers.

### Phase D: Verification and Python planner deprecation gate

Planner-ts is deprecation-ready when all are true:
- Functional parity checks pass for required planner flows.
- 25-50+ concurrency validation passes with acceptable p95 latency and error rate.
- No runaway queue growth or memory pressure in sustained load.
- Multi-pod session behavior is conflict-safe.
- OTEL trace stitching works across planner/yarn/mcp/admin path.

## Production defaults (planner-ts)

Current recommended baseline for new resilience knobs:
- `SYNESIS_PLANNER_TS_LLM_RETRY_MAX_ATTEMPTS=3`
- `SYNESIS_PLANNER_TS_LLM_RETRY_BASE_DELAY_MS=1000`
- `SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_FAILURE_THRESHOLD=5`
- `SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS=60000`
- `SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_HALF_OPEN_MAX=1`
- `SYNESIS_PLANNER_TS_NODE_TIMEOUT_MS=60000`
- `SYNESIS_PLANNER_TS_RATE_LIMIT_WINDOW_MS=60000`
- `SYNESIS_PLANNER_TS_RATE_LIMIT_MAX_REQUESTS=30`
- `SYNESIS_PLANNER_TS_STREAM_MAX_CONCURRENT=50`
- `SYNESIS_PLANNER_TS_STREAM_QUEUE_MAX=100`
- `SYNESIS_PLANNER_TS_STREAM_QUEUE_WAIT_MS=30000`

Tune per environment based on load-test telemetry, not ad hoc.

## Observability and OTEL guide pointer

Use `docs/OBSERVABILITY.md` as the current source of truth for:
- metrics naming and dashboards,
- service monitor coverage,
- trace ingestion patterns.

OTEL consistency updates should be merged into that doc (or a dedicated companion OTEL guide) once planner/yarn/mcp propagation is implemented.

## Historical source document

The discovery/research source remains:
- `docs/wip/PLANNER_TS_SCALABILITY_RESEARCH.md`

It should be maintained as historical evidence and marked for eventual removal after:
- all required phases are verified,
- this document remains current and complete,
- production rollout sign-off is recorded.
