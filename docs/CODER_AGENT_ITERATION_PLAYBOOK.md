# Coder Status, Snapshots, and Tracing Reference

This document is the operator and developer reference for Yarn coder status,
snapshots, and tracing. It replaces the old iteration playbook; implementation
backlogs and dated progress notes should live in issues or plans, not in this
reference.

Yarn is the TypeScript coder runtime in `base/yarn-ts/`. It serves
OpenAI-compatible and Claude-compatible coding traffic, records per-request
usage and trace data, emits session events, and feeds the Admin Yarn
observability pages.

## Canonical Sources

| Area | Source |
|------|--------|
| Runtime | `base/yarn-ts/` |
| Coder docs index | `docs/coder/README.md` |
| Architecture | `docs/coder/YARN_TS_SAWTOOTH_ARCHITECTURE.md` |
| Governor phases, diagrams, and verification telemetry | `docs/coder/GOVERNOR_HARNESS.md`, `docs/coder/observability-verification-and-evals.md` |
| Governor pause contract | `docs/coder/GOVERNOR_PAUSE_ENVELOPE.md` |
| Eval and replay telemetry | `docs/coder/EVAL_GYM.md` |
| Admin Yarn aggregation | `base/admin/app/services/yarn_service.py` |

## Data Flow

1. A coder request enters Yarn through the OpenAI-compatible or
   Claude-compatible route.
2. Yarn resolves the model tier from Admin registry data and provider keys.
3. Route preparation derives state from the current request, prior session
   metadata, tool history, and file snapshots.
4. The provider call runs through policy, reducer, governor, and telemetry
   layers.
5. Finalization writes usage, trace, session metadata, and session events.
6. Admin reads Yarn tables and trace records to render Yarn Overview,
   diagnostics, cost, and event drilldown views.

## Status Vocabularies

Yarn has several status vocabularies. They are intentionally separate because
they describe different things.

| Vocabulary | Values | Meaning | Source |
|------------|--------|---------|--------|
| Chat phase | `interpret`, `inspect`, `edit`, `verify`, `recover`, `finalize` | Semantic task state inferred from transcript and prior snapshot | `base/yarn-ts/src/governance/chat-state.ts` |
| Governor session phase | `explore`, `edit`, `verify`, `report`, `finalize` | Tool/event phase used by governor rules | `base/yarn-ts/src/governance/execution-governor.ts` |
| Completion status | `in_progress`, `blocked`, `ready_to_finalize`, `complete_claimed` | Whether the assistant can safely claim completion | `base/yarn-ts/src/governance/chat-state.ts` |
| Verification outcome | `pass`, `fail`, `unknown` | Latest verification result inferred from tool output | `base/yarn-ts/src/governance/chat-state.ts` |
| File status | `available`, `partial`, `unchanged`, `stale`, `evicted`, `missing` | Per-file context freshness and completeness | `base/yarn-ts/src/governance/file-state.ts` |

Use the chat phase when explaining user-visible task state. Use the governor
phase when debugging policy decisions, pauses, and repeated tool loops.

## Snapshot Types

Snapshots are compact state summaries. They are not full transcripts or full
file contents.

| Snapshot | Stored fields | Purpose |
|----------|---------------|---------|
| `chat_state_snapshot` | active objective, chat phase, pending directive, completion status, last verification outcome, correction counts, transcript summary, timestamp | Preserve task continuity across turns and restarts |
| `file_state_snapshot` | file count, status counts, stale files, partial files, evicted files, timestamp | Preserve context freshness without carrying full file bodies |
| `state_transition_v1` | previous/current state, changed fields, quality label/score, calibration metadata, training row | Explain whether a turn moved the session forward, stalled, or regressed |

`prepareProtocolPauseState()` writes `chat_state_snapshot` and
`file_state_snapshot` into session metadata before building governor pause
payloads. Trace finalization copies summarized state into `trace_context` so the
Admin trace view can show the same state without loading raw session metadata.

## Trace Records

Yarn trace records are built during request finalization and emitted to the
Admin trace pipeline. A trace should be treated as the request-level accounting
record.

Important fields:

| Field | Meaning |
|-------|---------|
| `trace_id` / `request_id` | Request identifier for this turn |
| `conversation_id` | Yarn session key |
| `parent_trace_id` / `root_trace_id` | Cross-turn lineage |
| `model` | Client-visible trace model |
| `trace_context.resolved_backend_model` | Provider/backend model selected for execution |
| `trace_context.registry_tier_id` | Admin registry tier used by Yarn |
| `trace_context.chat_state` | Compact chat-state summary |
| `trace_context.file_state` | Compact file-state summary |
| `trace_context.state_transition` | Transition quality summary |
| `tokens` / `cost` / `latency_ms` | Usage, cost, and timing |
| `optimization_ledger` | Prefix/cache/reduction metadata |

Implementation references:

- Trace construction: `base/yarn-ts/src/state/session-usage-persistence.ts`
- Trace assertions: `base/yarn-ts/tests/session-usage-persistence.test.ts`

## Session Events

Session events are written to `yarn_session_events` and drive event drilldowns,
training-data exports, and some Admin Yarn metrics.

| Event kind | Producer | Use |
|------------|----------|-----|
| `request_trajectory_v1` | Yarn finalization | Main request trajectory: workflow, tools, edits, verification, cost, outcome, governor, state channels, training signals |
| `state_transition_v1` | State transition ledger | Detailed state delta and quality assessment |
| `state_transition_quality_calibration_v1` | State transition ledger | Local threshold calibration when enough evidence shifts the decision boundary |
| `state_transition_quality_global_calibration_v1` | State transition ledger | Org/model-level calibration updates |
| `execution_governor_evaluated` | Execution governor | Rule evaluation, matched rules, pause decision, and counters |
| `scenario_eval_v1` | Eval gym | Scored scenario result |
| `eval_transcript_v1` | Eval session observer | Turn-by-turn live transcript for eval analysis |
| `live_eval_v1` | Eval session observer | Live anomaly alert when issues are detected |

`request_trajectory_v1` is the broadest event. Its metadata includes:

- `workflow`: decision path, phase, escalation, matched policy rules
- `tools`: sequence, counts by kind, retries, blind retries
- `edits`: read/write counts, patch ratio, whole-write ratio
- `verification`: verification steps, first-pass result, structured diagnostic
  coverage, completion/critic blocks
- `cost`: tokens, cache ratio, latency, token-economics metadata
- `outcome`: success/failure state and failure stage
- `governor`: pause, reason, matched rules, governor telemetry
- `state_channels`: chat, file, objective, confidence, and transition summaries
- `training_signals`: compact labels for quality analysis and fine-tuning

## Admin Metrics

The Admin Yarn Overview aggregates `yarn_usage_log`, `yarn_sessions`, and
`yarn_session_events`. The frontend contract is `YarnIntelligence` in
`base/admin/frontend/src/api/hooks.ts`.

Key trajectory metrics:

| Metric | Meaning |
|--------|---------|
| `trajectory_events` | Count of `request_trajectory_v1` events in the window |
| `first_pass_verify_rate` | Share of trajectories where first verification passed |
| `verification_stall_rate` | Share of trajectories flagged as stalled during verification |
| `blind_retry_rate` | Share of trajectories with repeated retries lacking new evidence |
| `patch_ratio` | Patch-style edits versus whole-file writes |
| `structured_error_coverage` | Structured diagnostics divided by diagnostic lines |
| `completion_gate_blocked_rate` | Share blocked by completion gate |
| `critic_block_rate` | Share blocked by critic gate |
| `trajectory_bucket_counts` | Distribution by task bucket |
| `state_transition_quality` | Forward/stalled/regressed/reground quality rollup |

## Debugging Queries

Use these patterns when investigating a coder turn. Adjust table/schema names
for the target environment.

Latest events for a request:

```sql
SELECT created_at, event_kind, component, detail, metadata_json
FROM yarn_session_events
WHERE request_id = '<request-id>'
ORDER BY created_at ASC;
```

Recent trajectories with verification or governor issues:

```sql
SELECT created_at, request_id, detail, metadata_json->'verification' AS verification,
       metadata_json->'governor' AS governor,
       metadata_json->'training_signals' AS training_signals
FROM yarn_session_events
WHERE event_kind = 'request_trajectory_v1'
  AND (
    metadata_json->'verification'->>'stalled' = 'true'
    OR metadata_json->'governor'->>'pause' = 'true'
    OR metadata_json->'verification'->>'completion_gate_blocked' = 'true'
  )
ORDER BY created_at DESC
LIMIT 50;
```

State transition quality for a session:

```sql
SELECT created_at, request_id,
       metadata_json->'quality' AS quality,
       metadata_json->'delta' AS delta
FROM yarn_session_events
WHERE session_key = '<session-key>'
  AND event_kind = 'state_transition_v1'
ORDER BY created_at ASC;
```

## Interpreting Common States

| Symptom | Likely meaning | Check next |
|---------|----------------|------------|
| `completion_status=blocked` | Yarn detected unresolved correction, failed verification, or completion guard | `chat_state_snapshot`, governor rules, latest verification step |
| `file_state.statusCounts.stale > 0` | File content in context may predate an edit | `file_state_snapshot.staleFiles`; rerun targeted read before final answer |
| `verification.stalled=true` | Repeated verification did not produce new progress | Tool sequence, `governor.telemetry.trailingVerificationRunLength` |
| High `blind_retry_rate` | Model repeated actions without new evidence | Tool sequence and `training_signals.no_edit_evidence` |
| Low `structured_error_coverage` | Tool output had diagnostics, but parser did not extract structured errors | `base/yarn-ts/src/mcp/handlers/command-diagnostics.ts` |
| `state_transition_quality_label=regressed` | Current turn degraded confidence or state continuity | `state_transition_v1.metadata_json.quality.reasons` |

## Related Docs

- `docs/coder/observability-verification-and-evals.md`
- `docs/coder/GOVERNOR_HARNESS.md`
- `docs/coder/GOVERNOR_PAUSE_ENVELOPE.md`
- `docs/coder/EVAL_GYM.md`
- `docs/coder/TOKEN_ECONOMICS_HARDENING.md`
