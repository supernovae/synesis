# Coder Agent Iteration Playbook

Use this document as the durable, repo-tracked source of truth for incremental agent quality work across Cursor restarts.

## Why this exists

- Keep long-running improvements chunked and auditable.
- Avoid losing context when sessions end.
- Tie every change to measurable outcomes (real users + synthetic canaries).

## Current focus

- Phase 0 complete: guardrail prompt + trajectory event foundation.
- Phase 1 complete (initial scope): structured `errors[]` diagnostics for `run_*` with fallback `errorLines`.
- Phase 2 active: telemetry quality and admin visibility loop.
- Next: language parser expansion (Python, then Rust).

## Status snapshot (2026-04-04)

- Implemented trajectory event emission (`request_trajectory_v1`) with tool sequence, verification, edit, and outcome metadata.
- Added structured diagnostics extraction for `run_*` tool outputs (`errors[]`, `errorLines`, compact summary).
- Added patch failure anatomy on `apply_patch` (`ok`, `reason`, `suggestedNextActions`, `contextHint`).
- Exposed trajectory intelligence in admin Yarn Overview:
  - `first_pass_verify_rate`
  - `verification_stall_rate`
  - `blind_retry_rate`
  - `patch_ratio`
  - `structured_error_coverage`
  - `trajectory_bucket_counts`
- Wired parser coverage into trajectory metadata emission:
  - `verification.structured_errors_count`
  - `verification.diagnostic_lines_count`
  - `verification.structured_error_coverage`
- Added completion-quality enforcement:
  - completion gate blocks finalization when verification remains red
  - bounded cleanup pass guidance is emitted on blocked completion
  - deterministic pre-finalization critic gate with optional LLM fallback
- Added KPI/alert support:
  - `completion_gate_blocked_rate`
  - `critic_block_rate`
  - SQL alert pack: `docs/clients/YARN_KPI_ALERT_PACK.md`
- Validation run status:
  - `base/yarn-ts`: `npm run -s typecheck` passed.
  - `base/admin/frontend`: build passed after telemetry UI additions.

## Resume protocol (every session)

1. Read this file, `docs/STAFF_CODER_RESEARCH_TRACKER.md`, and the latest section in `docs/clients/CANARY_PROMPT_PACK.md`.
2. Run a quick state check:
   - `git status --short --branch`
   - latest 5 commits on `main`
3. Pick exactly one chunk from the backlog below.
4. Implement + test + build.
5. Update this file:
   - mark chunk status
   - note KPI expectation
   - add commit hash and date

## Chunk backlog

### C1 - Parser coverage metrics (done)

- Add `structured_errors_count`, `diagnostic_lines_count`, `structured_error_coverage` to `mcp_tool_call` logs.
- Add canary run field guidance for those metrics.
- Expected impact: visibility into parser quality by language/preset.
- Implementation pointers:
  - `base/yarn-ts/src/mcp/index.ts` (mcp tool call diagnostics metadata + coverage calculation)
  - `docs/clients/CANARY_PROMPT_PACK.md` (canary run fields)
- Resume commands:
  - `rg "structured_errors_count|diagnostic_lines_count|structured_error_coverage" base/yarn-ts/src/mcp/index.ts`
  - `rg "structured_error_coverage|diagnostic_lines_count" docs/clients/CANARY_PROMPT_PACK.md`
  - `npm run -s test --workspace=base/yarn-ts`

### C1b - Admin trajectory exposure (done)

- Aggregate trajectory quality fields from `request_trajectory_v1` in admin service.
- Render trajectory KPIs and bucket distribution on Yarn Overview.
- Expected impact: operate from dashboard instead of raw logs.
- Implementation pointers:
  - `base/admin/app/services/yarn_service.py` (trajectory aggregates in `get_yarn_intelligence`)
  - `base/admin/frontend/src/api/hooks.ts` (`YarnIntelligence` contract)
  - `base/admin/frontend/src/pages/yarn/YarnOverview.tsx` (new KPI rows + trajectory bucket card)
- Resume commands:
  - `rg "trajectory_events|first_pass_verify_rate|structured_error_coverage|trajectory_bucket_counts" base/admin/app/services/yarn_service.py`
  - `rg "trajectory_events|structured_error_coverage|trajectory_bucket_counts" base/admin/frontend/src/api/hooks.ts`
  - `rg "First-pass verify rate|Structured parser coverage|Trajectory Buckets" base/admin/frontend/src/pages/yarn/YarnOverview.tsx`
  - `npm run -s build --prefix base/admin/frontend`

### C1c - Trajectory parser coverage emission (done)

- Compute diagnostics from tool-result messages and persist coverage in trajectory verification block.
- Keep backward compatibility: defaults to `0`/`1` semantics when diagnostics are absent.
- Expected impact: dashboard parser coverage reflects request-level behavior directly.
- Implementation pointers:
  - `base/yarn-ts/src/index.ts` (`inferTrajectoryDiagnosticsFromMessages` and trajectory metadata emission)
  - `base/yarn-ts/src/mcp/handlers/command-diagnostics.ts` (structured diagnostics extraction primitives)
  - `base/yarn-ts/src/mcp/handlers/coding-tools.ts` (`run_*` outputs include `errors[]` + `errorLines`)
- Resume commands:
  - `rg "inferTrajectoryDiagnosticsFromMessages|structured_error_coverage|structured_errors_count|diagnostic_lines_count" base/yarn-ts/src/index.ts`
  - `rg "extractStructuredErrors|StructuredDiagnostic" base/yarn-ts/src/mcp/handlers/command-diagnostics.ts`
  - `rg "errors:|errorLines|RunPresetResult" base/yarn-ts/src/mcp/handlers/coding-tools.ts`
  - `npm run -s typecheck --workspace=base/yarn-ts`

### C2 - Python diagnostics parser (done)

- Expand structured extractor for:
  - pytest summary / assertion patterns
  - Python traceback (`File "...", line N`) + exception message
- Tests:
  - parser unit tests for traceback and pytest failures
  - ensure fallback to `errorLines` remains stable
- Expected impact: higher targeted fix rate for Python runs.
- Resume commands:
  - `rg "extractStructuredErrors|StructuredDiagnostic|kind:" base/yarn-ts/src/mcp/handlers/command-diagnostics.ts`
  - `rg "python|pytest|traceback|File .* line" base/yarn-ts/tests`
  - `rg "run_test|run_build|errors:|errorLines" base/yarn-ts/src/mcp/handlers/coding-tools.ts`
  - `npm run -s test --workspace=base/yarn-ts -- command-diagnostics`
  - `npm run -s typecheck --workspace=base/yarn-ts`

### C3 - Rust diagnostics parser (done)

- Parse `cargo`/`rustc` lines into `errors[]` (`file`, `line`, `column`, message).
- Add tests and sample fixtures.
- Expected impact: improved file/line targeting for Rust loops.
- Resume commands:
  - `rg "extractStructuredErrors|StructuredDiagnostic" base/yarn-ts/src/mcp/handlers/command-diagnostics.ts`
  - `rg "rust|cargo|rustc" base/yarn-ts/src base/yarn-ts/tests`
  - `rg "structured_error_coverage|structured_errors_count|diagnostic_lines_count" base/yarn-ts/src/index.ts`
  - `npm run -s test --workspace=base/yarn-ts -- command-diagnostics`
  - `npm run -s typecheck --workspace=base/yarn-ts`

### C4 - Trajectory DQ checks in CI/ops script

- Add script/query pack for DQ checks from plan (`DQ1`-`DQ4`).
- Optional: nightly or weekly automation.
- Expected impact: prevent decisions based on bad telemetry.

## KPI targets (rolling)

- `first_pass_verify_rate`: upward trend by bucket.
- `tokens_to_green_p90`: downward trend.
- `patch_ratio` (micro/repo): keep above 0.60.
- `structured_error_coverage`: increasing trend per language over time.

## Decision log template

For each chunk, append:

- Date:
- Chunk ID:
- Hypothesis:
- KPI expected:
- Guardrails:
- Result:
- Commit:
- Rollback trigger (if any):

## Decision log

- Date: 2026-04-04
- Chunk ID: C1b
- Hypothesis: Exposing trajectory KPIs in admin will make weekly review actionable without log spelunking.
- KPI expected: faster detection of first-pass regressions and stall/blind-retry spikes.
- Guardrails: no schema breaks; tolerate missing trajectory fields.
- Result: completed; metrics visible on Yarn Overview and bucket distribution added.
- Commit: uncommitted in working tree
- Rollback trigger (if any): dashboard/API query latency regression or malformed aggregation values.

- Date: 2026-04-04
- Chunk ID: C1c
- Hypothesis: Emitting parser coverage in trajectory metadata enables consistent KPI tracking per request.
- KPI expected: reliable `structured_error_coverage` trend line over time.
- Guardrails: fallback behavior preserved when parser misses; coverage defaults are safe.
- Result: completed; trajectory verification now includes structured count, diagnostic count, and coverage.
- Commit: uncommitted in working tree
- Rollback trigger (if any): malformed payloads causing persistence errors or downstream query failures.

## Safety rules

- Do not weaken deterministic policy protection for repeat loops.
- Keep fallback behavior:
  - `errorLines` still present when parser misses.
  - no hard dependency on `errors[]` existing.
- Prefer additive telemetry fields over schema-breaking changes.

## Companion docs

- `docs/STAFF_CODER_RESEARCH_TRACKER.md` (research basis + implementation ledger + anti-perfection guardrails)
