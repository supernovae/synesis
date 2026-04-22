# Yarn Transition Calibration Observability

This doc explains how transition-quality telemetry appears in Admin, what operators
can do with it, and what to watch for in production.

## What You Can See In Admin

In **Coder → Overview**, the **State Transition Quality** panel now shows:

- average transition quality score
- label mix and counts (`forward_progress`, `stalled`, `regressed`, `reground_required`)
- average active threshold band (`regressed_max` → `forward_progress_min`)
- global-scope coverage (`org_model` / `model` / `none`)
- local/global calibration event counts + latest calibration timestamp
- top quality reasons from request trajectory training signals
- risk flags translated into actionable guidance

In **Coder → Transition Calibration**, operators get a dedicated trend dashboard with:

- quality score vs threshold-band line chart per time bucket
- transition label-rate trend chart (`forward_progress`, `stalled`, `regressed`, `reground_required`)
- local/global calibration cadence over time
- threshold panel with active risk flags and current warning cutoffs
- recent alert buckets with risk tags and quick triage metrics
- operator action recommendations derived from aggregate risk state

In **Coder session detail → Events**, operators can:

- filter events by **Transition quality risks**
- view trajectory chips for transition label, quality score, global scope, and calibration sample count
- inspect raw metadata JSON for `request_trajectory_v1`, `state_transition_v1`,
  `state_transition_quality_calibration_v1`, and
  `state_transition_quality_global_calibration_v1`

## What This Affords

- **Faster diagnosis of degradation:** high regressed/re-ground rates are visible without
  manually parsing event JSON.
- **Calibration confidence checks:** local vs global calibration activity clarifies whether
  thresholds are adapting or stuck.
- **Scope-quality auditing:** low global-scope coverage is explicit, so operators can catch
  org/model key churn and cold-start behavior.
- **Action loops:** top reasons + risk flags point to concrete next steps (prompt/governor
  tuning, file-memory hygiene, scope-key stability).

## Event Kinds That Matter

- `request_trajectory_v1`: carries training signals used for quality summaries.
- `state_transition_v1`: per-request transition record + training row.
- `state_transition_quality_calibration_v1`: session-local threshold recalibration.
- `state_transition_quality_global_calibration_v1`: cross-session/global threshold recalibration.

## Transition Calibration API

- `GET /api/v1/yarn/transition-quality?since_hours=<h>&bucket_minutes=<m>`
  - returns bucketed transition-quality trends
  - includes summary rollups, alert thresholds, top reasons, and alert buckets
  - powers the dedicated **Coder → Transition Calibration** page

## Admin Assistant + MCP Tools

Transition-quality telemetry is also exposed to the Admin Assistant through Admin MCP:

- `yarn_transition_quality`: direct access to transition-quality trend telemetry.
- `yarn_transition_events_tail`: risk-focused tail of `yarn_session_events` for transition event kinds.
- `yarn_transition_watch`: short live watch loop (poll + interval) for near-real-time incident triage.
- `yarn_transition_incident_brief`: synthesized operator brief that combines quality summary,
  event-tail signals, and recommended actions.

This enables conversation-first debugging without switching repeatedly between pages and raw
event JSON, reducing cognitive overhead during optimization and incident response.

## Operator Playbook

1. Open **Coder → Transition Calibration** and scan score trend + threshold crossings.
2. Check whether `regressed` or `reground_required` rates exceed warning thresholds.
3. Validate local/global calibration cadence is non-zero in active traffic windows.
4. Review top quality reasons and latest alert buckets.
5. Jump to **Coder → Events** (preset: Transition quality risks) for raw event diagnostics.
6. Sample affected sessions and confirm risk flags clear in the next 24h/7d windows.

## Watch-Outs

- **Eventual consistency:** global scope hydration/persist is asynchronous; different
  replicas may converge over seconds, not instantly.
- **Fail-open fallback:** if shared-store reads/writes fail, scoring continues using
  local/session thresholds and defaults.
- **Cold starts:** new org/model scopes start from defaults until sample volume crosses
  minimum gates.
- **Threshold drift:** monitor calibration event volume and label mix; over-aggressive
  smoothing or sparse samples can create unstable threshold movement.
- **Cardinality growth:** org/model scope keys can grow quickly in multi-tenant workloads;
  rely on TTL and bucket caps, and monitor Redis memory usage.
