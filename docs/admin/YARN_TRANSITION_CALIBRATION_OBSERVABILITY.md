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

## Operator Playbook

1. Open **Coder → Overview** and check `regressed` and `reground_required` rates.
2. If elevated, jump to **Events** and filter by **Transition quality risks**.
3. Inspect top quality reasons and sample affected sessions.
4. Confirm calibration events are flowing (local + global).
5. If global events are missing, validate Redis availability and scope-key stability.
6. Track whether risk flags clear over the next 24h/7d windows.

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
