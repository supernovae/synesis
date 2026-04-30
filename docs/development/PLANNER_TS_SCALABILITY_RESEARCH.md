# Planner TS — Scalability & Beta-Readiness Research

> **Scope:** Synesis Planner TS (`base/planner-ts/`), the LangGraph.js+Fastify
> replacement for the Python planner. This document audits architecture, scaling
> controls, state model, observability, and deployment posture. It includes a
> parity matrix against the Python planner and a phased scaling playbook.
>
> **Status:** Research draft — `docs/wip`, not tracked in public GitHub.
>
> **Date:** 2026-03-29

---

## Table of Contents

1. [Executive Summary](#1--executive-summary)
2. [Architecture Overview](#2--architecture-overview)
3. [Request Lifecycle](#3--request-lifecycle)
4. [Session & State Model](#4--session--state-model)
5. [LLM Client & Provider Resilience](#5--llm-client--provider-resilience)
6. [Admission Control & Rate Limiting](#6--admission-control--rate-limiting)
7. [Observability & Diagnostics](#7--observability--diagnostics)
8. [Security & Network Posture](#8--security--network-posture)
9. [Deployment & Resource Profile](#9--deployment--resource-profile)
10. [Planner Python Parity Matrix](#10--planner-python-parity-matrix)
11. [Fatal-Flaw Assessment](#11--fatal-flaw-assessment)
12. [Gap Prioritization & Recommendations](#12--gap-prioritization--recommendations)
13. [Scaling Playbook](#13--scaling-playbook)
14. [Config Knob Reference](#14--config-knob-reference)
15. [Validation Checklist](#15--validation-checklist)

---

## 1  Executive Summary

Planner TS is a Fastify/Node.js service (single-threaded event loop) that
orchestrates the full Synesis pipeline — entry classification, LLM planning,
RAG retrieval, writer generation, critic evaluation, and SSE streaming — via
LangGraph.js. It already ships with:

- Redis-backed session persistence (optional fallback to in-memory)
- OpenFGA + PAT-based authorization
- Prometheus metrics via `prom-client`
- Structured trace emission to admin (`emitTrace`)
- Network policy (ingress + egress scoped)
- Security context (non-root, drop ALL, seccomp)
- Background critic to unblock TTFT
- Injection scanning (input + output guardrails)
- Oscillation detection (style, decision, retrieval churn)
- LangGraph streaming with SSE phase annotations

**Key gaps** relative to the Python planner and multi-pod beta targets:

| # | Gap | Severity |
|---|-----|----------|
| 1 | No circuit breaker for LLM calls | **Critical** |
| 2 | No per-node timeout wrapper | **Critical** |
| 3 | No retry + exponential backoff on transient LLM errors | **High** |
| 4 | No per-user / per-org rate limiting | **High** |
| 5 | No global max-concurrent-streams admission | **High** |
| 6 | Prompt-level response cache intentionally not implemented (won't do for beta) | Low |
| 7 | No failure store (error pattern recording) | Medium |
| 8 | No health monitor for downstream deps | Medium |
| 9 | DB pool limit unbounded for PAT resolver | Medium |
| 10 | Retrieval cache intentionally deferred (won't do for beta) | Low |
| 11 | No L2 conversation archive (cross-restart) | Low |
| 12 | No OTEL tracing bootstrap | Low |
| 13 | Memory session store has no eviction cap | Medium |

**Verdict:** Planner TS is architecturally sound for single-pod/low-user beta.
For multi-pod and >5 concurrent users, items 1–5 must be addressed before
broader rollout.

**Update (2026-03-30):** Phase-1 runtime hardening items (circuit breaker,
retry/backoff, node timeout, user rate limiting, stream admission, readiness
split, network policy tightening) are implemented in planner-ts. Prompt-level
and retrieval caching are marked **won't do** for this effort to avoid stale
or ambiguous evidence behavior.

---

## 2  Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                  Fastify (Node.js)                       │
│                                                          │
│  POST /v1/chat/completions                               │
│    │                                                     │
│    ├─ resolveAuthContext (Bearer / PAT / Forwarded)       │
│    ├─ authorizeChatCompletions (OpenFGA policy engine)    │
│    ├─ toState (session enrich + context optimize)         │
│    │                                                     │
│    ├─ NON-STREAMING: invokeGraph() → JSON response       │
│    └─ STREAMING:                                         │
│         ├─ directStreamPipeline() (trivial fast-path)    │
│         └─ streamGraph() (full LangGraph via SSE)        │
│                                                          │
│  LangGraph.js StateGraph:                                │
│    entry_pipeline → planner → plan_gate → router         │
│      → writer → [critic | final_scrubber] → respond      │
│                                                          │
│  External deps:                                          │
│    ├─ LiteLLM gateway (model inference)                  │
│    ├─ Redis (sessions, optional)                         │
│    ├─ Postgres (PAT validation, via pg Pool)             │
│    ├─ NornicDB (RAG graph/vector search)                  │
│    ├─ TEI embedder (embedding service)                   │
│    ├─ BGE reranker (reranking service)                   │
│    ├─ SearXNG (web search)                               │
│    ├─ GLiNER (frame extraction)                          │
│    ├─ Admin service (pricing registry, trace sink)       │
│    └─ OpenFGA (authorization)                            │
└──────────────────────────────────────────────────────────┘
```

### 2.1  Concurrency model

Node.js single-threaded event loop. All LLM calls, retrieval, and DB queries
are async I/O. CPU-bound work is minimal (regex classification, domain
profiling, context optimization). The LangGraph.js graph is compiled once at
startup; streaming builds a per-request graph instance (for the writer delta
closure).

**Risk:** A single long-running LLM call blocks no other requests (it's
I/O-awaited), but many concurrent requests sharing the same event loop can
compete for microtask scheduling. N simultaneous streaming graph executions
each hold an open SSE connection and await multiple sequential LLM calls.

### 2.2  External dependency map

| Dependency | Protocol | Failure mode | Current handling |
|-----------|----------|-------------|-----------------|
| LiteLLM gateway | HTTP/JSON | 5xx, timeout, connection refused | `AbortController` + `setTimeout` (300s). No retry, no circuit breaker. |
| Redis (sessions) | TCP | Connection error, timeout | `ioredis` with `maxRetriesPerRequest: 3`, `retryStrategy` (200ms backoff, 3s cap). Falls back to `MemorySessionStore` at startup if URL empty. No runtime fallback. |
| Postgres (PATs) | TCP | Connection error, pool exhaustion | `pg.Pool` with `max: 5`. No circuit breaker. Pool exhaustion blocks auth resolution. |
| NornicDB | Bolt | Timeout, connection reset | Neo4j-compatible driver with configurable timeout. |
| TEI embedder | HTTP | 5xx, timeout | `AbortController` + timeout (10s default). No retry. |
| BGE reranker | HTTP | 5xx, timeout | `AbortController` + timeout (15s default). No retry. |
| SearXNG | HTTP | 5xx, timeout | `AbortController` + timeout (5s default). No retry. |
| GLiNER | HTTP | 5xx, timeout | Best-effort; catch-all in `frameExtractorNode`. |
| Admin (pricing, traces) | HTTP | 5xx, timeout | PricingRegistry startup non-fatal; trace emission fire-and-forget. |
| OpenFGA | HTTP | 5xx, timeout | Throws on failure → 403 to client. |

---

## 3  Request Lifecycle

### 3.1  Non-streaming path

```
1. Parse + validate (Zod ChatCompletionRequestSchema)
2. resolveAuthContext (PAT DB lookup or header forwarding)
3. authorizeChatCompletions (OpenFGA policy check)
4. resolvePlannerSessionKey (conversation_id or ephemeral)
5. toState:
   a. sessionManager.enrichIncomingMessages (inject checkpoint)
   b. optimizeContext (truncate long messages)
   c. scanUserInput (injection detection)
   d. buildDomainProfile
   e. consumePendingClarification
6. invokeGraph(initialState) → full pipeline
7. scanModelOutput (output guardrails)
8. sessionManager.recordTurn
9. spawnBackgroundCritic (fire-and-forget)
10. recordUsageMetrics + emitPlannerTrace
11. Return JSON response
```

### 3.2  Streaming path

Same as above through step 5, then:

```
6. initSse(reply.raw) + immediate "Synthesizing request" pulse
7a. directStreamPipeline (trivial fast-path, skips graph)
  OR
7b. streamGraph (full LangGraph):
    - writerDeltaHandler → writeContentDelta/writeReasoningDelta
    - phase annotations → writeReasoningDelta
8. scanModelOutput
9. sessionManager.recordTurn
10. spawnBackgroundCritic
11. writeFinalChunk + endSse
12. recordUsageMetrics + emitPlannerTrace
```

### 3.3  Latency breakdown (typical complex request)

| Phase | Typical latency | Bottleneck |
|-------|----------------|-----------|
| Auth (PAT DB + OpenFGA) | 10–50ms | Network RTT to Postgres + OpenFGA |
| Entry pipeline (classify + frame) | 50–200ms | GLiNER service call |
| Planner (LLM JSON plan) | 1–8s | LLM inference |
| Router (RAG + web search) | 0.5–5s | NornicDB + SearXNG + reranker |
| Writer (LLM streaming) | 3–30s | LLM inference + token generation |
| Critic (background) | 2–10s | LLM inference (non-blocking) |
| **Total (TTFT streaming)** | **2–15s** | **Entry + planner + router + first writer tokens** |

---

## 4  Session & State Model

### 4.1  Session stores

| Backend | Config | Behavior |
|---------|--------|----------|
| `MemorySessionStore` | No `REDIS_URL` | In-process `Map`. Lost on restart. No cross-pod sharing. No eviction cap. |
| `RedisSessionStore` | `SYNESIS_PLANNER_TS_REDIS_URL` set | Redis with `EX` TTL. Cross-pod sharing. `ioredis` with retry. |

**Session lifecycle:**
- `enrichIncomingMessages`: Injects checkpoint block (compacted history) into system message
- `recordTurn`: Appends user/assistant messages; triggers checkpoint + compaction when `history.length >= checkpointEveryMessages`
- `pruneExpired`: Memory store: manual sweep on each `ensureSession`; Redis: TTL-based

**Risk — Memory store has no cap:** `MemorySessionStore` grows unboundedly.
With N active sessions × M history entries, memory scales as O(N×M). The
`maxHistory` config (default 60) bounds per-session depth but not session count.
A sweep of expired sessions happens on every `ensureSession` call, but under
steady load with fresh sessions, the map can grow until OOM.

### 4.2  LangGraph state

The graph uses a single `GraphState` TypedDict passed through all nodes.
State is **not persisted** between requests — each request starts fresh from
`toState()`. The only inter-request persistence is the session checkpoint
(summary + recent history).

**Contrast with Python planner:** Python uses `LangGraphCheckpointer` backed
by Redis (`langgraph-checkpoint-redis`) for mid-graph state persistence and
cross-request state recovery. TS planner has no checkpointer.

### 4.3  Multi-pod session behavior

With Redis sessions enabled and sticky sessions:
- Sessions are shared across pods via Redis
- Session key: `conversation:${conversationId}` or `ephemeral:${requestId}`
- TTL: 14400s (4h) default

Without sticky sessions:
- Any pod can serve any request (sessions in Redis)
- No distributed locking — concurrent writes to the same session key are
  last-writer-wins via Redis `SET`
- No CAS/Lua — unlike Yarn's session store, planner-ts does not use
  compare-and-swap for session updates

---

## 5  LLM Client & Provider Resilience

### 5.1  Current implementation

`base/planner-ts/src/llm/client.ts`:
- `chatCompletion`: Non-streaming. `fetch` + `AbortController` with `timeoutMs` (default 300s).
- `chatCompletionStream`: Streaming. `fetch` + `AbortController` with `timeoutMs × 4` (1200s).
- No retry on transient errors (4xx/5xx).
- No circuit breaker.
- No fallback model.
- On timeout: `AbortController.abort()` → catch → propagate.

### 5.2  Python planner comparison

`base/planner/app/model_client.py`:
- `resilient_ainvoke`: Circuit breaker (per-role, 5-failure threshold, 60s recovery) + retry (1 retry, exponential backoff) + optional fallback LLM.
- `ChatOpenAI` with `max_retries=2` (LangChain-level retries).
- Prometheus metrics: `synesis_circuit_breaker_open_total`, `synesis_llm_retry_total`, `synesis_llm_fallback_total`.
- Retriable status detection: 429, 500, 502, 503, 504, plus timeout/connection errors.

### 5.3  Gap analysis

| Feature | Python planner | Planner TS | Risk |
|---------|---------------|-----------|------|
| Circuit breaker (per-role) | `CircuitBreaker` class + `get_breaker()` | **Missing** | A flapping LiteLLM endpoint causes every request to wait 300s before failing |
| Retry with backoff | `resilient_ainvoke` (1 retry, exp backoff) + LangChain `max_retries=2` | **Missing** | Transient 502/503 from gateway causes immediate failure |
| Fallback model | `fallback_llm` parameter in `resilient_ainvoke` | **Missing** | No degradation path when primary model is down |
| LLM metrics (CB, retry, fallback) | Prometheus counters + gauges | **Missing** | No visibility into LLM reliability patterns |
| Retriable error classification | `_is_retriable()` with status + connection checks | **Missing** | All errors treated as permanent failures |

---

## 6  Admission Control & Rate Limiting

### 6.1  Current state

**No admission control exists in planner-ts.** Every authenticated request
proceeds directly to graph execution. There is no:
- Per-user rate limit
- Per-org rate limit
- Global concurrent stream cap
- Queue for overflow
- Backpressure signaling (no 429 or 503 + Retry-After)

### 6.2  Python planner comparison

The Python planner also lacks explicit rate limiting at the application layer.
It relies on:
- `WEB_CONCURRENCY=1` (single Uvicorn worker per pod)
- Pod replicas (2) for horizontal scaling
- LiteLLM gateway for model-level rate limiting

### 6.3  Risk assessment

Without admission control, planner-ts is vulnerable to:
- **User flood:** A single user sending rapid requests consumes all LLM
  concurrency, starving other users
- **Cascade failure:** If LiteLLM is slow (not down), pending requests
  accumulate in the Node event loop, increasing memory and eventually causing
  OOM or event-loop starvation
- **No backpressure signal:** Clients have no way to know the service is
  overloaded; they retry aggressively, worsening the situation

### 6.4  Recommended controls (from Yarn pattern)

Port the following from `yarn-ts`:
- `UserRateLimiter` — sliding window per user (30 req/60s)
- `StreamAdmissionController` — global concurrent stream cap with overflow queue
- Circuit breaker — per LLM role

---

## 7  Observability & Diagnostics

### 7.1  What exists

| Signal | Implementation | Coverage |
|--------|---------------|----------|
| Structured logging | Fastify Pino (JSON) | All request paths, auth events, graph errors |
| Prometheus metrics | `prom-client` via `createServiceMetrics("planner", ...)` | Token usage, latency, model tier |
| Trace emission | `emitTrace()` to admin service | Per-request: spans, phase timings, classification, sensemaking, critic, evidence, taxonomy |
| Health endpoint | `GET /health` | Service status, session telemetry, LLM config, Redis config, auth config |
| Debug endpoints | `/health/authz-events`, `/debug/retrieval-config`, `/debug/session-stats` | Internal service token protected |
| SSE phase annotations | `writeReasoningDelta` with `[phase]` markers | Real-time pipeline progress |

### 7.2  What's missing

| Signal | Python planner | Planner TS | Priority |
|--------|---------------|-----------|----------|
| OTEL tracing (spans per node) | `with_telemetry_node` + `synesis_telemetry.span()` | **Missing** | Medium |
| Health monitor (dep probing) | `health_monitor.py` — periodic probe of all deps with CB + Prometheus | **Missing** | Medium |
| Failure store | `failure_store.py` — records error patterns for admin triage | **Missing** | Medium |
| Prompt-level cache metrics | `record_prompt_cache_hit/miss/size` | N/A (no prompt cache) | Low |
| Memory usage tracking | `resource.getrusage` after each request | **Missing** | Low |
| Diagnostic ring buffer | 20-entry in Yarn; none in planner-ts | **Missing** | Low |

### 7.3  SpanCollector

Planner TS does have a per-request `SpanCollector` (`tracing/span-collector.ts`)
that records start/end/metadata for each pipeline node. This is emitted in the
trace payload. However, it is not wired to OTEL — it is a custom in-process
collector only.

---

## 8  Security & Network Posture

### 8.1  Authentication

| Method | Implementation | Notes |
|--------|---------------|-------|
| Bearer PAT (`syn-` prefix) | `pat-resolver.ts` → Postgres lookup with HMAC-SHA256 + pepper | Pool `max: 5` |
| Internal service token | `resolveAuthContext` — trusted forwarded identity if token matches | Used by Open WebUI, admin |
| Anonymous | Allowed if `REQUIRE_BEARER_AUTH=false` | Read-only role, empty scopes |

### 8.2  Authorization

OpenFGA policy engine via `openfga-client.ts`. Policy decisions include matched
rules, exposed in `x-synesis-authz-rules` response header.

### 8.3  Network policy

`base/planner-ts/network-policy.yaml`:

| Direction | Allowed | Port |
|-----------|---------|------|
| Ingress | `synesis-admin`, `synesis-yarn`, `synesis-webui`, `synesis-mcp` pods | 8080/TCP |
| Egress | `synesis-gateway` namespace | 4000/TCP |
| Egress | DNS | 53/UDP+TCP |
| Egress | Fail-safe `{}` | Any |

**Issue:** The fail-safe `- {}` egress rule effectively allows all egress,
negating the policy's restrictiveness. This was added for startup/service
discovery edge cases. For production, this should be replaced with explicit
rules for all egress targets (Redis, Postgres, NornicDB, SearXNG, TEI, BGE
reranker, GLiNER, Admin, OpenFGA).

### 8.4  Container security

- `runAsNonRoot: true`
- `allowPrivilegeEscalation: false`
- `seccompProfile: RuntimeDefault`
- `capabilities.drop: ALL`

### 8.5  Input/output scanning

- Input: `scanUserInput` detects injection patterns (prompt injection, jailbreak)
- Output: `scanModelOutput` detects injection compliance in model responses
- Action modes: `reduce` (redact), `block` (400), `log` (warn only)

---

## 9  Deployment & Resource Profile

### 9.1  Current deployment

```yaml
replicas: 2
resources:
  requests: { cpu: 500m, memory: 1Gi }
  limits:   { cpu: "2", memory: 4Gi }
livenessProbe:  GET /health (15s initial, 15s period, 6 failures)
readinessProbe: GET /health (10s initial, 10s period, 6 failures)
```

### 9.2  Comparison with Python planner

| Aspect | Python planner | Planner TS |
|--------|---------------|-----------|
| Replicas | 2 | 2 |
| CPU request | 2 | 500m |
| CPU limit | 4 | 2 |
| Memory request | 6Gi | 1Gi |
| Memory limit | 12Gi | 4Gi |
| Workers per pod | 1 (Uvicorn, `WEB_CONCURRENCY=1`) | 1 (Node single-thread) |
| Liveness | TCP socket :8000 | HTTP GET /health :8080 |
| Readiness | HTTP /health/readiness | HTTP GET /health |
| HPA | None | None |

**Observation:** Planner TS has significantly lower resource requests. This is
appropriate for Node.js (smaller per-process footprint) but the 4Gi memory
limit may be tight under heavy concurrent load with large graph states.

### 9.3  Scaling concerns

| Concern | Detail |
|---------|--------|
| No HPA | Manual replica scaling only |
| Single worker model | One event loop per pod; CPU-bound work (unlikely) would block everything |
| No PDB | Pod disruption during rolling update could drop active streams |
| Readiness = liveness | Both hit `/health`; a pod with a stuck LLM call would still pass health checks |

---

## 10  Planner Python Parity Matrix

### 10.1  Resilience & safety features

| Feature | Python | TS | Gap severity | Notes |
|---------|--------|-----|:---:|-------|
| Circuit breaker (per LLM role) | `model_client.CircuitBreaker` | **Missing** | **Critical** | Flapping LiteLLM causes cascading 300s timeouts |
| Retry + exponential backoff | `resilient_ainvoke` (1 retry + LangChain 2 retries) | **Missing** | **Critical** | Transient errors cause immediate failure |
| Fallback model on CB open | `fallback_llm` in `resilient_ainvoke` | **Missing** | High | No degradation path |
| Per-node timeout (`with_timeout`) | `graph.py` wraps all nodes | **Missing** | **Critical** | Stuck LLM call blocks graph indefinitely (up to 300s/1200s) |
| Oscillation detector | `oscillation_detector.py` in `route_after_critic` | `oscillation-detector.ts` | **Parity** | TS implementation complete |
| Anti-oscillation force-terminate | Checked in `route_after_critic` | `critic-routing.ts` | **Parity** | |
| Validated node wrapper | `contract_validator.validated_node()` | `validated-node.ts` | **Parity** | Pre/post validators on writer, critic |
| Injection scanning (input) | `injection_scanner.scan_user_input` | `security/scanner.ts` | **Parity** | |
| Injection scanning (output) | `injection_scanner.scan_model_output` | `security/scanner.ts` | **Parity** | |
| Prompt-level response cache | `_prompt_cache` (in-memory, TTL, size-capped) | **Missing** | Medium | Saves LLM cost for repeated identical prompts |
| Failure store (error patterns) | `failure_store.record_error` + `failfast_cache` | **Missing** | Medium | Repeated errors bypass graph entirely |
| Health monitor (dep probing) | `health_monitor.py` with service CB + Prometheus | **Missing** | Medium | No awareness of downstream health |
| OTEL node spans | `with_telemetry_node` + `synesis_telemetry.span()` | **Missing** (custom SpanCollector only) | Low | Traces exist but not OTEL-distributed |

### 10.2  Session & memory features

| Feature | Python | TS | Gap severity | Notes |
|---------|--------|-----|:---:|-------|
| Redis session persistence | `LangGraphCheckpointer` (Redis) | `RedisSessionStore` | **Parity** | Different APIs but same goal |
| Session compaction | `summarize_pivot_history` | Structured checkpoint + `renderCheckpoint` | **Parity** | TS approach is simpler but effective |
| L2 conversation archive | `archive_to_l2` → Redis (7d TTL) | **Missing** | Low | Useful for post-incident analysis |
| Memory store eviction cap | `SYNESIS_MEMORY_MAX_USERS=5000` | **Missing** | Medium | MemorySessionStore grows unbounded |
| Short follow-up context enrichment | `pick_richer_conversation_transcript` | Session checkpoint injection | **Partial** | Different approach but serves same purpose |
| Conversation `/why` command | `_WHY_PATTERN` in `main.py` | **Missing** | Low | Developer convenience feature |

### 10.3  Retrieval & caching features

| Feature | Python | TS | Gap severity | Notes |
|---------|--------|-----|:---:|-------|
| Unified retrieval (RAG + web + reranker) | `unified_retrieval.py` + `rag_client.py` + `web_search.py` | `retrieval/client.ts` + `rag-client.ts` + `web-search.ts` | **Parity** | |
| Retrieval cache (semantic + exact) | `HybridRetrievalCache` (Redis-backed, semantic index) | **Missing** | Medium | Saves RAG cost for similar queries |
| Multi-query expansion (HyDE, conceptual) | `router_multi_query_enabled` | Router in `router.ts` | **Parity** | |
| BGE reranker | `unified_retrieval.py` | `rag-client.ts` (bgeRerank) | **Parity** | |
| Cohesion lock | `cohesion.py` | `retrieval/cohesion.ts` | **Parity** | |

### 10.4  Observability features

| Feature | Python | TS | Gap severity | Notes |
|---------|--------|-----|:---:|-------|
| Prometheus metrics | `api_metrics.py` (tokens, cache, iterations, errors, budget) | `createServiceMetrics` (tokens, latency, tier) | **Partial** | TS has fewer custom metrics |
| Structured trace to admin | `SynesisTracer` → `emitTrace` | `emitPlannerTrace` → `emitTrace` | **Parity** | Rich trace with spans, phases, taxonomy |
| Pino structured logging | `synesis_telemetry.get_logger` | Fastify Pino | **Parity** | |
| SSE status events (Open WebUI) | `_emit_phase` with `event` JSON key | `writeReasoningDelta` with phase brackets | **Different** | Different format; TS uses content-stream markers |
| Node confidence logging | `record_node_confidence` | SpanCollector confidence field | **Parity** | |
| Context curation metrics | `context_curation` in trace | `buildContextCuration` in trace | **Parity** | |

### 10.5  Deployment features

| Feature | Python | TS | Gap severity | Notes |
|---------|--------|-----|:---:|-------|
| Network policy | Exists (separate file) | `network-policy.yaml` | **Parity** | TS has fail-safe egress catch-all |
| `WEB_CONCURRENCY` / worker count | `WEB_CONCURRENCY=1` | N/A (single event loop) | N/A | Node.js model is inherently single-worker |
| Separate readiness probe | `/health/readiness` (checks LLM connectivity) | Same `/health` for liveness+readiness | **Gap** | TS should differentiate liveness vs readiness |
| Retrieval cache warm-on-startup | `SYNESIS_RETRIEVAL_CACHE_WARM_ON_STARTUP` | N/A (no cache) | Low | |
| PDB (Pod Disruption Budget) | None | None | Medium | Both need this for safe rolling updates |

---

## 11  Fatal-Flaw Assessment

| # | Flaw | Impact | When it bites | Severity |
|---|------|--------|--------------|----------|
| 1 | **No circuit breaker** | Stuck LLM endpoint causes every request to wait up to 300s (non-stream) or 1200s (stream) before failing. Under load, pending requests accumulate, exhaust memory, and cascade. | LiteLLM gateway degraded (slow responses, intermittent 502/503) | **Critical** |
| 2 | **No per-node timeout** | Python planner wraps every graph node with `with_timeout(settings.node_timeout_seconds)`. TS planner has no per-node guard — a stuck node blocks the entire request for the full LLM timeout. | Any external dep (NornicDB, SearXNG, GLiNER) becomes slow | **Critical** |
| 3 | **No LLM retry** | Any transient error (502, 503, 429) causes immediate request failure. Python has retry + backoff + fallback. | LiteLLM restart, gateway pod scaling, provider rate limit | **Critical** |
| 4 | **No admission control** | No limit on concurrent requests. N users × M concurrent requests all proceed to graph execution simultaneously. | >5 concurrent users, burst load | **High** |
| 5 | **MemorySessionStore unbounded** | When Redis is not configured, the in-memory session store grows without limit. | Development/staging without Redis, or Redis connection failure at startup | **Medium** |
| 6 | **Network policy egress catch-all** | `- {}` egress rule negates the policy. Any compromised process can reach any network destination. | Security audit, compliance review | **Medium** |
| 7 | **No readiness differentiation** | Liveness and readiness both hit `/health`. A pod with a stuck downstream dep still reports ready, receives traffic, and fails requests. | NornicDB/Redis/OpenFGA down | **Medium** |

---

## 12  Gap Prioritization & Recommendations

### Phase 0: Pre-beta (address before any multi-user testing)

| # | Gap | Recommendation | Files to touch | Effort |
|---|-----|---------------|----------------|--------|
| 1 | Circuit breaker | Port `CircuitBreakerRegistry` pattern from `yarn-ts` or implement per-role CB in `llm/client.ts`. Wire into `chatCompletion` and `chatCompletionStream`. | `llm/client.ts`, new `llm/circuit-breaker.ts` | ~130 lines |
| 2 | Per-node timeout | Create `withTimeout(timeoutMs)` wrapper (mirrors Python `with_timeout`). Apply to all nodes in `graph.ts`. On timeout: set `error` + `next_node: "respond"`, forward required keys. | New `nodes/with-timeout.ts`, `graph.ts` | ~80 lines |
| 3 | LLM retry + backoff | Add `resilientFetch` wrapper: classify retriable errors (429, 500-504, timeout, connection), retry with exponential backoff (max 2 retries), integrate with circuit breaker. | `llm/client.ts` | ~60 lines |
| 4 | Per-user rate limiter | Port `UserRateLimiter` from `yarn-ts`. Apply in `/v1/chat/completions` handler before graph execution. | New `middleware/user-rate-limit.ts`, `app.ts` | ~100 lines |
| 5 | Global stream admission | Port `StreamAdmissionController` from `yarn-ts`. Apply to streaming path. | New `middleware/stream-admission.ts`, `app.ts`, `config.ts` | ~150 lines |

### Phase 1: Beta hardening (5–10 users)

| # | Gap | Recommendation | Files to touch | Effort |
|---|-----|---------------|----------------|--------|
| 6 | Prompt cache | **Won't do for this effort.** Keep planner-ts uncached at prompt/retrieval level to preserve referential integrity and avoid stale-evidence ambiguity after corpus updates. | N/A | Decision |
| 7 | MemorySessionStore cap | Add `maxSessions` parameter. On insert: if at cap, evict oldest by `lastSeenAt`. | `context/session-store.ts` | ~15 lines |
| 8 | Readiness probe differentiation | Add `GET /health/readiness` that checks LLM reachability (LiteLLM `/health`) and Redis connectivity. Keep `/health` as liveness (always 200 if process alive). | `app.ts` | ~30 lines |
| 9 | Failure store | Record error patterns (error type, stage, count) for admin dashboard. Fast-fail cache for repeated identical errors. | New `diagnostics/failure-store.ts`, `app.ts` | ~80 lines |
| 10 | Network policy tighten | Replace egress `- {}` catch-all with explicit rules for Redis, Postgres, NornicDB, SearXNG, TEI, BGE reranker, GLiNER, Admin, OpenFGA. | `network-policy.yaml` | ~40 lines |
| 11 | DB pool monitoring | Add `pool.on('error')` logging. Expose pool stats in `/health`. Consider `pg-pool` idle timeout. | `auth/pat-resolver.ts`, `app.ts` | ~10 lines |

### Phase 2: Scale-out (10–25 users)

| # | Gap | Recommendation | Files to touch | Effort |
|---|-----|---------------|----------------|--------|
| 12 | HPA | Add `HorizontalPodAutoscaler` targeting CPU 70%. Start 2–4 replicas. | New `hpa.yaml` | Manifest |
| 13 | PDB | Add `PodDisruptionBudget` (`minAvailable: 1`). | New `pdb.yaml` | Manifest |
| 14 | Retrieval cache | **Won't do for this effort.** Revisit only with explicit provenance-safe cache invalidation and evidence freshness guarantees. | N/A | Decision |
| 15 | OTEL tracing | Bootstrap `@opentelemetry/*` SDK. Wrap node functions with OTEL spans. Export to Jaeger/OTLP collector. | New `telemetry/otel.ts`, `pipeline.ts` | ~100 lines + deps |
| 16 | Health monitor | Periodic probe of all downstream deps (LiteLLM, Redis, NornicDB, etc). Expose aggregate health in `/health/deps`. Fire Prometheus alerts on failures. | New `diagnostics/health-monitor.ts` | ~120 lines |

### Phase 3: Production (25–100+ users)

| # | Gap | Recommendation | Effort |
|---|-----|---------------|--------|
| 17 | L2 conversation archive | Persist compacted history to Redis with 7d TTL for cross-restart and debugging | ~50 lines |
| 18 | Redis Sentinel / cluster | Move from single Redis to Sentinel or cluster for HA | Infra |
| 19 | Session CAS (Lua) | Add compare-and-swap for session updates to prevent lost writes under concurrent access | ~40 lines |
| 20 | Per-org token budget | Track org-level token spend and enforce limits | ~100 lines |
| 21 | Prometheus alerting rules | Define alerts for CB open, high latency, error rate, memory pressure | Manifests |

---

## 13  Scaling Playbook

### 13.1  Current state (1–2 users) — works as-is

The current deployment with 2 replicas, Redis sessions, and OpenFGA auth is
sufficient for 1–2 concurrent users. Monitor via `/health` and admin traces.

### 13.2  Phase 1: 5–10 concurrent users

| Action | Component | Effort | Status |
|--------|-----------|--------|--------|
| Implement circuit breaker | `llm/client.ts`, `llm/circuit-breaker.ts` | ~130 lines | DONE |
| Implement per-node timeout | `graph.ts` | ~80 lines | DONE |
| Implement LLM retry + backoff | `llm/client.ts` | ~60 lines | DONE |
| Implement per-user rate limiter | `middleware/user-rate-limit.ts`, `app.ts` | ~100 lines | DONE |
| Implement global stream admission | `middleware/stream-admission.ts`, `app.ts` | ~150 lines | DONE |
| Add prompt-level response cache | `cache/prompt-cache.ts` | ~60 lines | WON'T DO |
| Cap MemorySessionStore | `context/session-store.ts` | ~15 lines | DONE |
| Differentiate readiness probe | `app.ts`, `deployment.yaml` | ~30 lines | DONE |
| Tighten network policy egress | `network-policy.yaml` | ~40 lines | DONE |

### 13.3  Phase 2: 10–25 concurrent users

| Action | Component | Effort | Status |
|--------|-----------|--------|--------|
| Add HPA (2–4 replicas, CPU 70%) | `hpa.yaml` | Manifest | DONE |
| Add PDB (`minAvailable: 1`) | `pdb.yaml` | Manifest | DONE |
| Add session CAS baseline (WATCH/MULTI retry) | `context/session-store.ts`, `context/session-manager.ts` | ~120 lines | DONE |
| Add retrieval cache | `retrieval/cache.ts` | ~200 lines | WON'T DO |
| Add OTEL tracing | `telemetry/otel.ts`, `index.ts`, `app.ts`, `llm/client.ts` | ~100 lines + deps | IN PROGRESS |
| Add health monitor | `diagnostics/health-monitor.ts`, `app.ts` | ~120 lines | DONE |
| Implement failure store | `diagnostics/failure-store.ts`, `app.ts` | ~80 lines | DONE |

### 13.4  Phase 3: 25–100+ concurrent users

| Action | Component | Effort |
|--------|-----------|--------|
| L2 conversation archive | Session manager | ~50 lines |
| Redis HA (Sentinel/cluster) | Infrastructure | Ops |
| Session CAS with Lua | `context/session-store.ts` | ~40 lines |
| Per-org token budget | New module | ~100 lines |
| Prometheus alerting rules | Manifests | Ops |

---

## 14  Config Knob Reference

### 14.1  Existing knobs

| Env var | Default | Purpose |
|---------|---------|---------|
| `SYNESIS_PLANNER_TS_LLM_TIMEOUT_MS` | 300000 | Timeout for non-streaming LLM calls |
| `SYNESIS_PLANNER_TS_SESSION_ENABLED` | true | Enable session management |
| `SYNESIS_PLANNER_TS_SESSION_MAX_HISTORY` | 60 | Max message entries per session |
| `SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_MESSAGES` | 12 | Messages before checkpoint compaction |
| `SYNESIS_PLANNER_TS_SESSION_TTL_MS` | 14400000 | Session inactivity TTL (4h) |
| `SYNESIS_PLANNER_TS_REDIS_URL` | `` | Redis URL (empty = memory store) |
| `SYNESIS_PLANNER_TS_REDIS_KEY_PREFIX` | `synesis:planner:session:` | Redis key namespace |
| `SYNESIS_PLANNER_TS_REDIS_SESSION_TTL_S` | 14400 | Redis session TTL |
| `SYNESIS_PLANNER_TS_CONTEXT_MAX_CHARS` | 12000 | Max chars per message in context window |
| `SYNESIS_PLANNER_TS_CONTEXT_RECENT_MESSAGE_LIMIT` | 24 | Recent messages to keep in full |
| `SYNESIS_INJECTION_SCAN_ENABLED` | true | Enable input/output injection scanning |
| `SYNESIS_INJECTION_ACTION` | reduce | Action on injection: reduce, block, log |
| `SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH` | true (in deploy) | Require Bearer token |
| `SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS` | true (in deploy) | Trust forwarded identity from gateway |
| `SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE` | true (in deploy) | Reject untrusted forwarded headers |
| `SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE` | auto | vLLM prefix caching mode |
| `SYNESIS_PLANNER_TS_CRITIC_BACKGROUND` | true | Run critic asynchronously |
| `SYNESIS_PLANNER_TS_CRITIC_SKIP_BELOW_DIFFICULTY` | 0.15 | Skip critic for trivial tasks |
| `SYNESIS_PLANNER_TS_CRITIC_LENIENT_BELOW_DIFFICULTY` | 0.4 | Lenient scoring for easy tasks |

### 14.2  Recommended new knobs

| Env var | Recommended default | Purpose |
|---------|-------------------|---------|
| `SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | 5 | Circuit breaker: failures before open |
| `SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS` | 60000 | Circuit breaker: time in open before half-open |
| `SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_HALF_OPEN_MAX` | 1 | Circuit breaker: probe requests in half-open |
| `SYNESIS_PLANNER_TS_LLM_RETRY_MAX_ATTEMPTS` | 3 | Max attempts on transient LLM errors |
| `SYNESIS_PLANNER_TS_LLM_RETRY_BASE_DELAY_MS` | 1000 | Exponential backoff base |
| `SYNESIS_PLANNER_TS_NODE_TIMEOUT_MS` | 60000 | Per-node timeout for graph execution |
| `SYNESIS_PLANNER_TS_RATE_LIMIT_WINDOW_MS` | 60000 | Rate limit sliding window |
| `SYNESIS_PLANNER_TS_RATE_LIMIT_MAX_REQUESTS` | 30 | Max requests per user per window |
| `SYNESIS_PLANNER_TS_STREAM_MAX_CONCURRENT` | 50 | Global concurrent stream cap per pod |
| `SYNESIS_PLANNER_TS_STREAM_QUEUE_MAX` | 100 | Overflow queue depth |
| `SYNESIS_PLANNER_TS_STREAM_QUEUE_WAIT_MS` | 30000 | Queue wait timeout |
| `SYNESIS_PLANNER_TS_SESSION_MAX_SESSIONS` | 5000 | Memory store: max concurrent sessions |

---

## 15  Validation Checklist

Use this checklist to verify each implementation item.

### Circuit breaker

- [x] `chatCompletion` and `chatCompletionStream` route through circuit breaker
- [ ] Breaker opens after N consecutive failures (configurable)
- [ ] Breaker transitions to half-open after recovery timeout
- [ ] Half-open allows 1 probe request; success closes, failure re-opens
- [x] Returns 503 + `Retry-After` when breaker is open
- [ ] Prometheus gauge: `synesis_planner_ts_circuit_breaker_state{role}`
- [ ] Verify: kill LiteLLM → requests fail fast (not 300s timeout)

### Per-node timeout

- [x] All graph nodes wrapped with timeout guard (`SYNESIS_PLANNER_TS_NODE_TIMEOUT_MS`)
- [x] On timeout: `state.error` set, `next_node: "respond"`, required keys forwarded
- [ ] Verify: inject artificial delay in router node → request completes with error within timeout

### LLM retry + backoff

- [x] Transient errors (429, 500-504, timeout, connection) trigger retry
- [ ] Exponential backoff: 2s, 4s (2 retries max)
- [ ] Non-retriable errors (400, 401, 403) fail immediately
- [ ] Retry count recorded in Prometheus counter
- [ ] Verify: return 503 from LiteLLM once → request succeeds on retry

### Per-user rate limiter

- [x] Sliding window counter per authenticated user
- [x] Returns 429 + `Retry-After` when exceeded
- [x] Periodic sweep evicts idle entries
- [x] Stats in `/health`
- [ ] Verify: send 25 requests from same user in 60s → 429 after limit

### Global stream admission

- [x] Cap on concurrent streaming graph executions per pod
- [x] Overflow queue with bounded depth + timeout
- [x] Returns 503 + `Retry-After` when queue full
- [x] Guaranteed slot release on completion, error, disconnect
- [x] Stats in `/health`
- [ ] Verify: fill cap + queue → next request gets 503

### Readiness probe differentiation

- [x] `/health/readiness` checks LiteLLM health endpoint
- [x] `/health/readiness` checks Redis PING
- [x] Returns 503 if any critical dep is down
- [x] `/health` remains simple liveness (200 if process alive)
- [ ] Verify: stop Redis → readiness fails, liveness passes

### Network policy tightening

- [x] Remove `- {}` egress catch-all
- [ ] Add explicit egress rules for: Redis, Postgres, NornicDB, SearXNG, TEI, BGE reranker, GLiNER, Admin, OpenFGA
- [ ] Verify: `kubectl exec` into pod → cannot reach unauthorized services

---

*End of document.*
