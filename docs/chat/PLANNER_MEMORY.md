# Planner Memory And Request-State Debugging

This page explains planner-ts memory pressure and the current instrumentation
operators can use to debug large requests, long streams, and session growth.

For conversation lifecycle behavior, key derivation, and purge semantics, see
[`PLANNER_MEMORY_LIFECYCLE.md`](PLANNER_MEMORY_LIFECYCLE.md).

## Why Memory Can Grow

- **Graph state per request:** Each run carries messages, execution plan,
  evidence packets, decision ledger entries, node traces, critic state, and
  generated draft content. Long prompts, broad retrieval, and critic loops
  increase this state.
- **Streaming accumulator:** The streaming path keeps accumulated response state
  while emitting OpenAI-compatible chunks. Large responses increase memory for
  the duration of the request.
- **Evidence packets:** Router-owned RAG/web retrieval deduplicates and budgets
  evidence, but high top-k, graph expansion, and repeated evidence-gap loops can
  still create larger in-memory packets.
- **Session store:** `SessionManager` keeps recent conversation history and
  checkpoints. With `SYNESIS_PLANNER_TS_REDIS_URL` it persists through Redis;
  otherwise it is in-process memory.
- **Operational buffers:** authz decision events, failure store entries, health
  snapshots, prompt/capability caches, and rate/stream admission state are
  bounded but still part of process RSS.

## Current Bounds

- `SYNESIS_PLANNER_TS_SESSION_MAX_HISTORY`
- `SYNESIS_PLANNER_TS_SESSION_MAX_SESSIONS`
- `SYNESIS_PLANNER_TS_SESSION_TTL_MS`
- `SYNESIS_PLANNER_TS_CONTEXT_MAX_CHARS`
- `SYNESIS_PLANNER_TS_CONTEXT_RECENT_MESSAGE_LIMIT`
- `SYNESIS_PLANNER_TS_RAG_TOP_K`
- `SYNESIS_RAG_OVERFETCH_MIN` / `SYNESIS_RAG_OVERFETCH_MAX`
- `SYNESIS_PLANNER_TS_NODE_TIMEOUT_MS`
- `SYNESIS_PLANNER_TS_WRITER_NODE_TIMEOUT_MS`
- `SYNESIS_PLANNER_TS_STREAM_MAX_CONCURRENT`
- `SYNESIS_PLANNER_TS_STREAM_QUEUE_MAX`
- `SYNESIS_PLANNER_TS_STREAM_QUEUE_WAIT_MS`

The graph also has bounded retry behavior: critic loops route to router/writer
only under explicit verdicts and terminate through `final_scrubber` when
iteration, oscillation, or validation pressure says to stop.

## Instrumentation

Planner exposes:

- `GET /health` for simple liveness.
- `GET /health/readiness` for dependency-aware readiness.
- `GET /health/detailed` for session telemetry, optimizer counters, LLM
  resilience, prompt/capability registry state, stream admission, failures, and
  authz policy counters. Requires the internal service token.
- `GET /debug/session-stats` for session backend/TTL. Requires the internal
  service token.
- `GET /metrics` for Prometheus metrics. Requires the internal service token.

Important code references:

- Request lifecycle and streaming: `base/planner-ts/src/app.ts`
- Graph routing and node timeouts: `base/planner-ts/src/graph.ts`
- Session persistence: `base/planner-ts/src/context/session-manager.ts` and
  `session-store.ts`
- Retrieval and evidence packets: `base/planner-ts/src/retrieval/*`
- Config limits: `base/planner-ts/src/config.ts`

## Debug Workflow

1. Check whether the issue is concurrency or a single large request:

   ```bash
   curl -H "Authorization: Bearer $SYNESIS_INTERNAL_SERVICE_TOKEN" \
     http://localhost:8080/health/detailed
   ```

2. Inspect `admissionControl.streamAdmission` for queued or saturated streams.
3. Inspect `session` for active sessions, checkpoint count, and backend.
4. Check retrieval config:

   ```bash
   curl -H "Authorization: Bearer $SYNESIS_INTERNAL_SERVICE_TOKEN" \
     http://localhost:8080/debug/retrieval-config
   ```

5. Correlate request logs by `x-synesis-run-id`, `x-synesis-authz-trace-id`, and
   any OpenTelemetry traceparent propagated by the caller.

OOM risk is usually from one of three sources: unusually large prompts,
retrieval overfetch/graph expansion, or long streamed outputs. Tune the bounds
above before increasing pod/container memory.
