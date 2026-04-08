# Harness Intake Playbook

This playbook converts external harness/benchmark learnings into safe, testable Yarn improvements.

## Intake Rubric

Score each candidate on:

- `Transferability`: `high | medium | low`
- `Effort`: `S | M | L`
- `Expected ROI`: `token_efficiency | success_rate | latency | safety` (one or more)
- `Verifiability`: does it have a deterministic replay/eval test?
- `Rollout safety`: feature flag + kill switch available?

Only ship candidates that are `high/medium transferability`, `S/M effort`, and have replay coverage.

## Top 10 No-Regret Adoptions

| # | Pattern | Source Family | Yarn Mapping | Effort | ROI |
|---|---|---|---|---|---|
| 1 | Root wildcard discovery hard block | SWE-agent / ACI | `tool-collapse/discovery-guardrails.ts` | S | token_efficiency,safety |
| 2 | Metadata-first directory discovery | Harness engineering catalog | `mcp/handlers/coding-tools.ts:list_dir` | S | token_efficiency |
| 3 | Empty-result remediation hints | SWE-agent ACI post-processing | `reduction/tool-result-reducer.ts` + MCP search/list tools | S | success_rate |
| 4 | Duplicate tool-call collapse | ACI/runtime best practice | `dedupe/*`, `tool-collapse/*` | S | token_efficiency,latency |
| 5 | Intent gate for “add tests” entry | SWE-bench workflow discipline | `index.ts` + `execution-governor.ts` | M | success_rate |
| 6 | Cleanup TODO/FIXME harvest gate | Harness workflow design | `execution-governor.ts` | S | success_rate |
| 7 | Completion gate with verification evidence | OpenHands critic loop + eval discipline | `index.ts:applyCompletionGate` | M | safety,success_rate |
| 8 | Guided truncation envelopes | Context engineering guidance | `tool-result-reducer.ts` | S | token_efficiency |
| 9 | Request-forensics cache/effective-input KPIs | Evals & observability playbooks | `telemetry/request-forensics.ts` | S | token_efficiency |
| 10 | Replay-first rollout for guardrails | SWE-bench/OpenHands eval practice | `tests/*replay*`, `tests/*guardrail*` | M | safety,success_rate |

## Standard Adoption Workflow

1. Add candidate to this table with source and target file mapping.
2. Implement behind flag (default conservative).
3. Add replay test covering both pass and fail trajectory.
4. Add telemetry event/KPI for behavior change.
5. Roll out to coder clients first.
6. Keep kill switch documented in deployment env.

## Suggested Quarterly Benchmark Loop

- Review updates from:
  - SWE-bench Verified
  - OpenHands engineering/critic posts
  - MCP-related benchmark updates (MCP Bench/MCPMark)
  - Terminal-agent benchmarks (Terminal-Bench/Harbor)
- Promote at most 3 candidates per quarter into implementation backlog.
- Require before/after replay comparison and token-in slope delta for each shipped candidate.
