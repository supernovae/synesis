# Coder Agent Iteration Playbook

Use this document as the durable, repo-tracked source of truth for incremental agent quality work across Cursor restarts.

## Why this exists

- Keep long-running improvements chunked and auditable.
- Avoid losing context when sessions end.
- Tie every change to measurable outcomes (real users + synthetic canaries).

## Current focus

- Phase 0 complete: guardrail prompt + trajectory event foundation.
- Phase 1 in progress: structured `errors[]` diagnostics for `run_*`.
- Next: parser coverage expansion by observed traffic.

## Resume protocol (every session)

1. Read this file and the latest section in `docs/clients/CANARY_PROMPT_PACK.md`.
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

### C2 - Python diagnostics parser (next)

- Expand structured extractor for:
  - pytest summary / assertion patterns
  - Python traceback (`File "...", line N`) + exception message
- Tests:
  - parser unit tests for traceback and pytest failures
  - ensure fallback to `errorLines` remains stable
- Expected impact: higher targeted fix rate for Python runs.

### C3 - Rust diagnostics parser

- Parse `cargo`/`rustc` lines into `errors[]` (`file`, `line`, `column`, message).
- Add tests and sample fixtures.
- Expected impact: improved file/line targeting for Rust loops.

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

## Safety rules

- Do not weaken deterministic policy protection for repeat loops.
- Keep fallback behavior:
  - `errorLines` still present when parser misses.
  - no hard dependency on `errors[]` existing.
- Prefer additive telemetry fields over schema-breaking changes.
