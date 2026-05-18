# Scaling Architecture

How Synesis planner-ts and yarn-ts scale horizontally, survive Kubernetes
lifecycle events, and handle session state across pods.

---

## Overview

| Service | Session store backend | Multi-replica safe? | Session affinity | HPA ready |
|---------|----------------------|--------------------|-----------------|---------:|
| **planner-ts** | Redis (full `SessionData`) | Yes | Not required | Yes |
| **yarn-ts** | Redis (`SessionRecord` + full `SessionStateSnapshot`) | Yes | Recommended | Yes |

Both services persist session state to Redis and can survive pod restarts,
rolling updates, and HPA scale events without data loss. The Helm chart
ships optional HPA and PDB templates gated by values flags.

---

## Planner-ts

### State model

```
┌─────────────┐       ┌───────────────────────────┐
│  planner-ts │──────▶│  Redis                    │
│  (pod N)    │       │  yarn-ts:session:{key}     │
│             │       │  Full SessionData JSON     │
│  In-memory: │       │  (history, checkpoint,     │
│  - rate lim │       │   clarification, TTL)      │
│  - circuit  │       │  CAS versioning            │
│    breakers │       └───────────────────────────┘
│  - stream   │
│    admission│
└─────────────┘
```

**What is in Redis (survives pod migration):**
- Complete `SessionData` — conversation history, checkpoint state, pending
  clarification, last-seen timestamp — persisted as JSON with TTL.
- Compare-and-set (CAS) via `WATCH`/`MULTI` ensures safe concurrent writes
  from multiple pods.

**What is in-memory only (resets on pod restart):**
- `UserRateLimiter` — per-user sliding-window counters. Intentionally per-pod;
  after restart, each user gets a fresh window (brief leniency, not a gap).
- `StreamAdmissionController` — concurrent SSE stream tracking. Resets to
  zero on restart which is correct (no streams survive a restart).
- `CircuitBreakerRegistry` — upstream failure tracking. Resets on restart,
  causing a brief probe burst to previously-failing upstreams until the
  breaker re-opens if they are still down.
- `PromptSnapshot` — prompt library cache, refreshed from Admin on a timer.
  Carried per-request through `GraphState._prompt_snapshot` (no module-global).

### Multi-replica behavior

When `replicas > 1`, any pod can serve any request for a given session:

1. Request arrives at pod B.
2. Pod B calls `sessionStore.get(key)` → Redis returns the full session.
3. Pod B processes the request, mutates session state.
4. Pod B calls `sessionStore.mutate(key, ...)` with CAS — if version
   conflicts (another pod wrote first), the CAS loop retries with the
   latest version.

No session affinity is required.

### Readiness probe

`GET /health/readiness` checks Redis connectivity (`PING`). If Redis is
unreachable, the probe returns 503 and Kubernetes removes the pod from
service endpoints until it recovers.

---

## Yarn-ts

### State model

```
┌──────────────┐       ┌──────────────────────────────┐
│  yarn-ts     │──────▶│  Redis                       │
│  (pod N)     │       │                              │
│              │       │  yarn-ts:session:{key}        │
│  In-memory:  │       │    SessionRecord (accounting, │
│  - sessions  │       │    metadata, continuity)      │
│    Map       │       │                              │
│  - structural│       │  yarn-ts:state:{key}          │
│    index     │       │    SessionStateSnapshot       │
│  - file snap │       │    (history, governor state,  │
│  - dedup     │       │     counters, task ledger)    │
│  - memory    │       │                              │
│    governor  │       │  yarn-ts:artrep:{id}          │
│  - artifacts │       │    Artifact payloads (replica)│
│    (+ Redis  │       │                              │
│     replica) │       │  yarn-ts:rl:{userId}          │
│              │       │    Rate limit sorted sets     │
│              │       │                              │
│              │       │  yarn-ts:continuity:{userId}  │
│              │       │    Cross-session continuity   │
└──────────────┘       └──────────────────────────────┘
                               │
                       ┌───────┴──────────────────────┐
                       │  Postgres                     │
                       │  Usage rows, session traces,  │
                       │  safety events                │
                       └──────────────────────────────┘
```

**What is in Redis (survives pod migration):**

| Redis key pattern | Content | Lifecycle |
|---|---|---|
| `yarn-ts:session:{key}` | `SessionRecord` — token accounting, cost, tier, metadata bag, continuity, CAS version | Saved on every request completion via CAS |
| `yarn-ts:state:{key}` | `SessionStateSnapshot` — full transcript history, governor counters (consecutive tool calls, stagnant cycles, signal hashes), artifact edit turns, failure signatures, pruning watermark | Saved alongside SessionRecord on every request completion |
| `yarn-ts:artrep:{id}` | Artifact payload replica — tool results and validation outputs | Written on artifact creation; TTL matches artifact store |
| `yarn-ts:rl:{userId}` | Rate limiter sorted set — sliding-window timestamps | Managed atomically via Lua script; auto-expires |
| `yarn-ts:continuity:{userId}` | Cross-session continuity — task context, key findings, plan graph | Updated on session save when history > 2 messages |

**What is in-memory only (cold-starts on pod migration):**

| Data | Impact of cold start | Recovery |
|---|---|---|
| `structuralIndexBySession` | No incremental code index | Rebuilds from tool traffic within 1-2 tool calls |
| `fileSnapshotBySession` | No stale-edit detection | Rebuilds from `read_file` / `write_file` calls |
| `contentDedupBySession` | Duplicate tool outputs may pass through | Rebuilds from tool traffic |
| `memoryGovernorBySession` | Memory signals reset | Conservative behavior (safe default) |
| `blockedDiscoveryBySession` | Discovery blocking counters reset | Rebuilds from glob/search blocking |
| `CircuitBreakerRegistry` | Upstream failure memory lost | Brief probe burst, re-opens if upstream still failing |

These in-memory caches are derived data that rebuilds incrementally from
normal tool traffic. A session migrating to a new pod experiences a brief
period of degraded optimization (e.g. duplicate tool results aren't
deduplicated, structural index is incomplete) but no functional breakage.

### Session lifecycle on pod migration

```
Pod A (being terminated)          Pod B (receiving request)
─────────────────────────         ────────────────────────
1. SIGTERM received
2. preStop hook: sleep 5s
   (in-flight requests drain)
3. snapshotSessionsToRedis()
   - saves SessionStateSnapshot
     for every active session
   - saves SessionRecord
4. app.close()
   - UsageWriter.flush()          5. Request arrives for session X
   - Redis/Postgres cleanup       6. sessions.get(X) → miss
                                  7. sessionStore.load(X) → SessionRecord
                                  8. sessionStore.loadSessionState(X)
                                       → SessionStateSnapshot
                                  9. rehydrateFromSnapshot(state, snap)
                                       → full history + governor state
                                  10. Session continues seamlessly
```

### Multi-replica behavior

With `sessionAffinity: ClientIP` enabled (recommended), the same client
IP routes to the same pod, keeping the in-memory caches warm. If a pod
dies or the client IP changes, the session is rehydrated from Redis with
full fidelity for the core state and degraded-but-functional behavior for
derived caches.

Without session affinity, every request may hit a different pod. The full
`SessionStateSnapshot` (including transcript history and governor state)
is always rehydrated from Redis, so correctness is preserved. Performance
is slightly reduced because per-session caches (structural index, dedup,
file snapshots) start cold on each new pod encounter.

### Readiness probe

`GET /health/readiness` checks Redis connectivity (`PING`). Returns 503
if Redis is unreachable, causing Kubernetes to stop routing traffic to
that pod until the connection recovers.

---

## Kubernetes lifecycle

### Pod startup

```
1. Container starts
2. startupProbe begins polling (failureThreshold: 60, period: 5s = 5min max)
3. App initializes: Redis connection, Postgres pool, auth resolver
4. readinessProbe starts (period: 10s) — checks Redis PING
5. Pod added to Service endpoints when ready
```

### Rolling update

```
1. New pod starts (startup probe)
2. New pod becomes ready → receives traffic
3. Old pod marked for termination
4. preStop hook fires: sleep 5s (drain in-flight)
5. SIGTERM → graceful shutdown
   - Planner: sessionStore.disconnect()
   - Yarn: snapshotSessionsToRedis() → app.close() → flush
6. terminationGracePeriodSeconds: 60s hard deadline
7. Old pod removed
```

### HPA scale-up

```
1. CPU > 70% target sustained
2. HPA creates new pod
3. New pod starts, passes probes, joins endpoints
4. Load balancer distributes traffic (session affinity may route
   existing clients to old pods)
5. New sessions and migrated sessions work via Redis state
```

### HPA scale-down

```
1. CPU < 70% target sustained
2. HPA selects pod for termination (respects PDB minAvailable: 1)
3. Same graceful shutdown as rolling update
4. Active sessions on terminated pod:
   - Planner: next request hits another pod, loads from Redis (seamless)
   - Yarn: next request hits another pod, rehydrates from snapshot
     (seamless for core state, cold caches for derived data)
```

### Node drain / eviction

```
1. kubectl drain / cluster autoscaler eviction
2. PDB enforced: at least 1 pod stays running
3. Evicted pod follows graceful shutdown path
4. Sessions redistribute to surviving pods
```

---

## Helm configuration

### Enabling autoscaling

```yaml
workloads:
  plannerTs:
    replicas: 2  # ignored when HPA is enabled
    autoscaling:
      enabled: true
      minReplicas: 2
      maxReplicas: 4
      targetCPUUtilizationPercentage: 70
    podDisruptionBudget:
      enabled: true
      minAvailable: 1

  yarn:
    replicas: 1  # ignored when HPA is enabled
    autoscaling:
      enabled: true
      minReplicas: 1
      maxReplicas: 3
      targetCPUUtilizationPercentage: 70
    podDisruptionBudget:
      enabled: true
      minAvailable: 1
    sessionAffinity:
      type: ClientIP
      timeoutSeconds: 10800  # 3 hours
```

### Lifecycle configuration (defaults in chart)

```yaml
workloads:
  plannerTs:
    terminationGracePeriodSeconds: 60
    lifecycle:
      preStop:
        exec:
          command: ["sh", "-c", "sleep 5"]

  yarn:
    terminationGracePeriodSeconds: 60
    lifecycle:
      preStop:
        exec:
          command: ["sh", "-c", "sleep 5"]
```

---

## Rate limiting under multi-replica

### Planner-ts

Rate limiting is **in-memory per pod**. With 2 replicas, a user gets up to
`SYNESIS_PLANNER_TS_RATE_LIMIT_MAX_REQUESTS` per pod per window. This is
intentional — the Fastify `@fastify/rate-limit` plugin and the custom
`UserRateLimiter` both operate per-process. For stricter global limits,
use ingress-level rate limiting (NGINX annotations or Cloudflare rules).

### Yarn-ts

Rate limiting uses **Redis sorted sets** when Redis is available, providing
a true global sliding window across all pods. Falls back to in-memory per
pod if Redis is unreachable.

---

## Capacity planning guidelines

| Metric | Planner-ts | Yarn-ts |
|--------|-----------|---------|
| CPU per pod | 500m request / 2 cores limit | 500m request / 2 cores limit |
| Memory per pod | 1Gi request / 4Gi limit | 500Mi request / 2Gi limit |
| Typical concurrent sessions | ~50 per pod | ~30 per pod (higher memory per session) |
| Redis memory per session | ~50-200KB (full SessionData) | ~100-500KB (SessionRecord + StateSnapshot) |
| HPA trigger | CPU > 70% | CPU > 70% |
| Scale-up time | ~30s (startup probe) | ~30s (startup probe) |
| Session migration time | Instant (Redis read) | Instant (Redis read + rehydrate) |

### Redis sizing

Estimate Redis memory as:
```
(max_concurrent_sessions × avg_session_size_kb) + 20% overhead
```

For 500 concurrent sessions across both services:
- Planner: 500 × 200KB = ~100MB
- Yarn: 500 × 500KB = ~250MB
- Total: ~400MB (well within a standard Redis instance)

---

## Troubleshooting

### Session not found after pod restart

1. Check Redis connectivity: `redis-cli PING` from the pod.
2. Verify `SYNESIS_YARN_SESSION_REDIS_URL` / `SYNESIS_PLANNER_TS_REDIS_URL` is set.
3. Check session TTL: default is 4 hours (`SYNESIS_YARN_SESSION_TTL_MS`).
4. Look for `session_state_rehydrated` log entries on the new pod.

### Rate limit not enforced across pods (yarn)

1. Verify `memoryStoreRedis` is connected (check `/health/telemetry`).
2. Check `userRateLimiter` stats: `backend` should be `"redis"`.
3. If `"memory"`, Redis sorted-set operations are failing silently.

### HPA not scaling

1. Verify `metrics-server` is running: `kubectl top pods`.
2. Check HPA status: `kubectl get hpa -n <namespace>`.
3. Ensure resource requests are set (HPA needs them for percentage calc).

### Pod stuck terminating

1. Check `terminationGracePeriodSeconds` (default 60s).
2. Look for stuck `UsageWriter.flush()` or Redis operations in logs.
3. If shutdown exceeds 60s, Kubernetes sends SIGKILL.
