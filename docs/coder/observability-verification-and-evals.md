# Observability, Verification, and Evals

## Observability

### Trace Decision Analytics (Phase 18)

The admin service aggregates decision-routing metrics directly from trace `full_record` JSONB:

| Metric | Source | API |
|--------|--------|-----|
| Decision path distribution (deterministic/constrained/inference_first/abstain) | `decision_ledger[0].path` | `GET /api/v1/traces/analytics` |
| Escalation rate | `decision_ledger[0].escalated` | `GET /api/v1/traces/analytics` |
| Recall routing distribution (bypass/enrich/passthrough) | `decision_ledger[0].recall_routing` | `GET /api/v1/traces/analytics` |
| Evidence prefetch hit rate | `evidence_prefetch_hit` | `GET /api/v1/traces/analytics` |

Query params: `since` (unix ts), `until` (unix ts), `org_id`. RBAC: requires `org_observability` route group.

### Conformance Rollups (Phase 18)

Durable periodic snapshots of Yarn runtime telemetry stored in `conformance_rollups` table:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/conformance/summary` | GET | Latest per-language conformance with delta vs previous scrape |
| `/api/v1/conformance/history` | GET | Time-series rollups for dashboard charts (`?language=go&limit=100`) |
| `/api/v1/conformance/scrape` | POST | Manual trigger to scrape Yarn `/health/telemetry` (platform-admin) |

Metrics tracked per language pack: family count, classifier/reducer coverage, fast path patterns, verification commands, fix recipes, recall bypass/enrich attempts, verification loops/findings/stalls.

Global metrics: recall stats, verification stats, decision path counts, escalations/deescalations, sensemaking triggered/skipped.

### Trace Enrichment (Phase 9)

Per-request `DecisionSnapshot` populates trace `full_record` with: `evidence_summary`, `decision_ledger`, `trace_context`, `streaming`, `taxonomy`, `is_code_task`.

## Verification

### Verification Loops (Phase 7b)

Language pack `VerificationCommands` wired into pipeline for deterministic verification and self-repair. `VerificationLoopState` tracks rounds, findings, stalls with configurable max rounds and stall threshold.

### Recall Engine (Phase 7a)

Fix recipes from language packs matched against error patterns. Confidence-based bypass routing: high confidence -> deterministic bypass, medium -> enriched prompt, low -> passthrough to LLM.

## Evaluation

### Golden-Prompt Eval Harness (Phase 18)

Curated prompt suites executed against Yarn's OpenAI-compatible API with expectation assertions:

| Suite | Cases | Tests |
|-------|-------|-------|
| `recall_bypass` | 5 | Prompts expected to hit deterministic fast paths |
| `verification_loop` | 3 | Prompts that should trigger verification loops |
| `decision_quality` | 4 | Mixed prompts testing decision path routing quality |
| `latency_budget` | 2 | Latency and token budget assertions |

API: `GET /api/v1/evals/suites` (list), `POST /api/v1/evals/run` (execute, platform-admin).

### Testing Labs (Phase 18)

Execution engine replays prompts from historical traces against Yarn:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/testing-labs/runs/{run_id}/execute` | POST | Replay prompts against Yarn, populate results |
| `/api/v1/testing-labs/runs/{run_id}/regressions` | GET | Rule-based regression detection report |

Regression detection rules:
- **Verdict degradation**: baseline pass -> candidate fail
- **Latency regression**: candidate >2x baseline
- **Token regression**: candidate >2x baseline
- **Decision path degradation**: deterministic -> constrained -> inference_first -> abstain

## Replay and Audit

Support policy replay against historical traces to evaluate:

- candidate threshold changes
- constitution updates
- source ranking adjustments
- client-adapter conformance
