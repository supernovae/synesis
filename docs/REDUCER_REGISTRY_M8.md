# M8: Reducer Registry + Rapid Iteration

This milestone adds command-aware reducers to shrink noisy tool output before it reaches the model.

## What ships

- Reducer registry with classifier-driven dispatch in `base/yarn-ts/src/reduction/`.
- Top reducers:
  - `pytest` grouped failures
  - `tsc` grouped by file and TS code
  - `lint` grouped by rule/file (eslint/ruff)
  - `git` status/diff/log summaries
  - `search` file-level match aggregation
- Fail-safe behavior: if reducer is not applicable or fails, Yarn falls back to artifact-handle summaries instead of blocking requests.
- Runtime controls:
  - `SYNESIS_YARN_REDUCERS_ENABLED`
  - `SYNESIS_YARN_REDUCER_FAMILIES`
  - `SYNESIS_YARN_REDUCER_MIN_CONFIDENCE`
  - `SYNESIS_YARN_REDUCER_PROFILE` (`balanced|aggressive|ultra`)
- Telemetry in `/health/telemetry` including reducer lifecycle (enabled/degraded/disabled), failures, fallback counts, and savings.
- Admin Yarn Ops panel now includes reducer performance and lifecycle cards.

## Why this matters

- Reduces token spend upstream, not only via late-stage compaction.
- Gives deterministic reductions for common engineering workflows.
- Preserves debuggability with artifact handles for full raw output recovery.

## Rapid iteration workflow

- Add or adjust fixtures in `base/yarn-ts/tests/fixtures/reducers/`.
- Run regression tests: `npm test`.
- Run fixture benchmark: `npm run bench:reducers`.
- Compare `savedPct`, failure counts, and lifecycle transitions after reducer changes.
