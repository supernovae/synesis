# Yarn Feature Activation Playbook

Staged rollout guide for Synesis Yarn runtime intelligence features.
Each stage enables a set of feature flags, with health gates to pass before
proceeding to the next stage.

## Prerequisites

- Yarn deployment healthy at `/health` (200 OK)
- `/health/telemetry` endpoint accessible (returns JSON with feature flags, stats, and pool info)
- Redis reachable for session continuity and diagnostic persistence
- Admin DB connection pool healthy (check `connectionPools.auth` in telemetry)

---

## Stage 1: Recall Engine

Enable the recall bypass and confidence scoring pipeline. This is the foundation
that all downstream intelligence features depend on.

| Flag | Value |
|------|-------|
| `SYNESIS_YARN_RECALL_BYPASS_ENABLED` | `true` |
| `SYNESIS_YARN_RECALL_CONFIDENCE_FLOOR` | `0.6` (default) |

### Health gates

1. `/health/telemetry` → `featureFlags.recallBypass` is `true`
2. `toolResultReduction.recall.totalDecisions` increments on requests
3. `toolResultReduction.recall.bypassSuccesses` > 0 after ~50 requests with tool output
4. Error rate at upstream provider unchanged (no spike in 5xx from model)
5. P95 latency increase < 50ms (recall lookup is in-memory)

### Rollback

Set `SYNESIS_YARN_RECALL_BYPASS_ENABLED=false` and restart. Recall engine
becomes passive — all tool results flow through to the model unchanged.

---

## Stage 2: Verification Loop

Enable deterministic verification of model outputs using language pack
verification commands.

| Flag | Value |
|------|-------|
| `SYNESIS_YARN_VERIFICATION_PLAN_ENABLED` | `true` |
| `SYNESIS_YARN_VERIFICATION_MAX_ROUNDS` | `3` (default) |

### Health gates

1. `featureFlags.verificationPlan` is `true` in telemetry
2. `toolResultReduction.verificationStats.loopsStarted` > 0
3. `toolResultReduction.verificationStats.stallCount` is 0 or very low
4. No increase in upstream 5xx errors
5. Event loop lag P95 < 100ms (`eventLoopLag.p95Ms` in telemetry)

### Rollback

Set `SYNESIS_YARN_VERIFICATION_PLAN_ENABLED=false`. Verification loop tracker
still records state but never triggers self-repair suggestions.

---

## Stage 3: Decision Matrix

Enable evidence-aware routing that selects deterministic, constrained,
inference-first, or abstain paths based on recall confidence and verification
outcomes.

| Flag | Value |
|------|-------|
| `SYNESIS_YARN_DECISION_MATRIX_ENABLED` | `true` |
| `SYNESIS_YARN_DETERMINISTIC_PATH_THRESHOLD` | `0.9` (default) |
| `SYNESIS_YARN_CONSTRAINED_PATH_THRESHOLD` | `0.5` (default) |
| `SYNESIS_YARN_ABSTAIN_EVIDENCE_FLOOR` | `0.15` (default) |

### Health gates

1. `featureFlags.decisionMatrix` is `true`
2. `orchestratorStats.deterministicCount` + `constrainedCount` > 0
3. `orchestratorStats.abstainCount` is low relative to total (< 5%)
4. `orchestratorStats.escalationCount` is stable, not climbing
5. No degradation in user-perceived response quality

### Rollback

Set `SYNESIS_YARN_DECISION_MATRIX_ENABLED=false`. Orchestrator falls back to
phase-only routing without evidence-aware path selection.

---

## Stage 4: Sensemaking Engine

Enable future-backward reasoning for explore-phase requests with insufficient
evidence. This injects structured exploration plans into the model context.

| Flag | Value |
|------|-------|
| `SYNESIS_YARN_SENSEMAKING_ENABLED` | `true` |
| `SYNESIS_YARN_SENSEMAKING_GAP_THRESHOLD` | `0.5` (default) |

### Health gates

1. `featureFlags.sensemaking` is `true`
2. `sensemakingStats.triggered` > 0 after explore-phase requests
3. `sensemakingStats.plansGenerated` > 0
4. Exploration plans produce measurably better tool selection in explore phase
5. Event loop lag unchanged (sensemaking is synchronous but fast)

### Rollback

Set `SYNESIS_YARN_SENSEMAKING_ENABLED=false`. Gap analysis still runs but
exploration plans are never injected into the model context.

---

## Stage 5: Governance and Policy

Enable the deterministic policy engine and governance constitution evaluation.

| Flag | Value |
|------|-------|
| `SYNESIS_YARN_GOVERNANCE_ENABLED` | `true` |

### Health gates

1. `featureFlags.governance` is `true`
2. Admin API reachable for governance artifact fetching
3. `policyPrecheck.matchedRules` appears in diagnostics
4. No false-positive policy rejections (check diagnostic ring for `policy_hard_reject` events)
5. Tool loop guardrails behave correctly (test with multi-turn sessions)

### Rollback

Set `SYNESIS_YARN_GOVERNANCE_ENABLED=false`. Policy engine returns empty
matched rules and no injections occur.

---

## Stage 6: Observability and Persistence

Enable diagnostic persistence to Redis and OpenTelemetry tracing.

| Flag | Value |
|------|-------|
| `SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED` | `true` |
| `SYNESIS_YARN_DIAGNOSTIC_REDIS_TTL_S` | `86400` (default, 24h) |
| `SYNESIS_YARN_OTEL_ENABLED` | `true` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `<your collector endpoint>` |

### Health gates

1. `GET /v1/diagnostics/:requestId` returns stored diagnostics for recent requests
2. Trace spans visible in your OTEL collector (Jaeger/Tempo)
3. `diagnosticPersistence` shows `true` in telemetry
4. Redis memory usage is stable (TTL eviction working)
5. No performance regression from OTEL span overhead (< 5ms P95 increase)

### Rollback

Set `SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED=false` and/or
`SYNESIS_YARN_OTEL_ENABLED=false`. Diagnostic ring buffer still works
in-memory; OTEL spans become no-ops.

---

## Canary Strategy

For production environments, enable flags for a single org/tenant first:

1. **Governance constitution override**: Create a constitution for the canary
   org that sets all feature flags to `true` while the global defaults remain
   `false`.
2. **Monitor per-org**: Use the admin trace query endpoints filtered by
   `org_id` to compare canary org metrics against baseline orgs.
3. **Promote gradually**: Once canary org metrics are stable for 24-48 hours,
   promote flags to the next ring of orgs, then globally.

## Global Rollback Criteria

Disable the most recently enabled flag if any of:

- **Error rate** increases > 2% above baseline
- **P95 latency** increases > 200ms above baseline
- **Event loop lag P99** exceeds 500ms
- **Compaction failures** (`toolResultReduction.compactionFailures`) spike
- **Connection pool saturation** (`connectionPools.auth.waitingCount` > 0 sustained)
- **Upstream model errors** increase (circuit breaker opens frequently)

## Telemetry Reference

All health checks use the `GET /health/telemetry` endpoint. Key sections:

| Section | What to check |
|---------|--------------|
| `featureFlags` | Confirm each flag is in expected state |
| `eventLoopLag` | `p95Ms` < 100ms, `p99Ms` < 500ms |
| `connectionPools.auth` | `waitingCount` == 0, `idleCount` > 0 |
| `connectionPools.usageWriter` | Same as above |
| `toolResultReduction` | `compactionFailures` stable, `reducedCount` growing |
| `toolResultReduction.recall` | `bypassSuccesses` growing, `totalDecisions` > 0 |
| `orchestratorStats` | Path distribution is reasonable |
| `sensemakingStats` | `triggered` > 0 when sensemaking enabled |
| `memoryUsage` | `heapUsedMB` stable, no leaks |
| `uptime` | Pod not restarting |
