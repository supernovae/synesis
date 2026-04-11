# Planner TS Scaling and Production Status

## Purpose

This document tracks the **current** scaling/reliability state of `planner-ts` and the objective TODOs for production hardening.

This is the only planner in scope. No Python planner migration/deprecation plan is tracked here.

Target operating envelope remains **25-50+ concurrent users** with stable latency/error behavior.

## Current State (Implemented)

### Runtime resilience

- LLM retry + circuit breaker is implemented in `base/planner-ts/src/llm/client.ts` and `base/planner-ts/src/llm/circuit-breaker.ts`.
- Per-node timeout enforcement is implemented in `base/planner-ts/src/graph.ts`.
- Dedicated writer-node timeout support is implemented (writer-specific timeout config in planner config/graph flow).
- User rate limiting is implemented and enforced in `base/planner-ts/src/middleware/user-rate-limit.ts` and `base/planner-ts/src/app.ts`.
- Stream admission control is implemented and enforced in `base/planner-ts/src/middleware/stream-admission.ts` and `base/planner-ts/src/app.ts`.

### Health, readiness, and diagnostics

- Liveness endpoint: `/health`.
- Dependency readiness endpoint: `/health/readiness`.
- Additional operational diagnostics are exposed via dependency and failure health surfaces in planner-ts.
- Deployment probes are aligned to the readiness/liveness split.

### Multi-pod/session safety

- Redis session-store conflict-safe mutation path exists (WATCH/MULTI retry loop).
- Redis key enumeration path uses `SCAN` instead of `KEYS`.
- In-memory fallback has explicit session-cap/eviction behavior.

### Kubernetes scaling posture

- Planner HPA/PDB manifests are present and wired in planner kustomization.
- Network policy has fail-closed baseline hardening (no broad fail-open egress defaults).

### Observability baseline

- Planner OTEL bootstrap + request span baseline is in place (OpenTelemetry JS SDK **2.x**, OTLP/HTTP; see [`docs/dependency-migrations.md`](dependency-migrations.md)).
- Telemetry trace lineage fields (`conversation_id`, `parent_trace_id`, `root_trace_id`) are emitted and ingested by admin.

### Conversation continuity and follow-up handling

- Conversation ID fallback capture is implemented on planner ingress for OpenWebUI-style calls (body/metadata/header fallback sources).
- Clarification follow-up merge is implemented (original task + clarification answer merged for replanning).
- Short quiz-option follow-up handling is implemented (`a)`, `b)`, etc.) by merging prior assistant quiz context before planning.

## Objective TODO (Not Done Yet)

1. Run and publish repeatable load gates at 25/35/50 concurrency (stream + non-stream), with pass/fail thresholds on p95 latency and error rate.
2. Finalize OTEL propagation consistency across planner, yarn, mcp, and admin (`traceparent`/request correlation end-to-end validation, not just baseline spans).
3. Add/expand regression tests for short-answer conversational follow-ups (quiz-style, clarification-style, and other context-dependent one-token replies).
4. Validate and tune default admission/rate/timeouts per environment from measured production-like load, then lock environment-specific baselines.
5. Add dashboard/alert definitions for stream queue pressure, breaker-open rate, admission rejects, and dependency-health degradation.

## Explicit Non-Goals (Current)

- No prompt-level or retrieval-response caching rollout in planner-ts in this effort.
- No Redis/Postgres infrastructure provisioning/HA topology design in this document.

## Load Verification Harness

```bash
cd base/planner-ts

# 25 concurrent users (non-stream)
PLANNER_URL=http://localhost:8080 \
PLANNER_MODEL="Synesis Auto" \
PLANNER_BEARER_TOKEN="<token>" \
npm run load:verify -- --concurrency 25 --requests 250 --stream false

# 50 concurrent users (streaming)
PLANNER_URL=http://localhost:8080 \
PLANNER_MODEL="Synesis Auto" \
PLANNER_BEARER_TOKEN="<token>" \
npm run load:verify -- --concurrency 50 --requests 500 --stream true
```

Treat non-zero error rate or unstable p95/p99 under sustained load as release blockers.

## Production Knob Baseline

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

Tune from measured telemetry, not ad hoc edits.

## Reference

- Observability source of truth: `docs/OBSERVABILITY.md`
- Historical research notes: [PLANNER_TS_SCALABILITY_RESEARCH.md](./PLANNER_TS_SCALABILITY_RESEARCH.md)
