# Execution Governor: Phase-Aware Loop Prevention

The execution governor prevents LLM coding agents from getting stuck in
low-yield loops — re-reading unchanged files, repeating passing tests,
cycling between exploration and verification without making progress.

It runs inside the Yarn proxy (`base/yarn-ts`) and operates transparently:
the governor evaluates the conversation on every HTTP request from the
client (Claude Code, Cursor, etc.) and injects recovery guidance or
hard-stops the response before it reaches the backend model.

For a visual graph view of the current state machine and escalation flow, see `docs/coder/GOVERNOR_STATE_GRAPH.md`.

## Problem: flat rules vs. session phases

Early versions used a flat bag of 29 rules, all gated on "has the model
made any file edits?" (`noEditEvidence`). This works for edit loops but
is exactly wrong for three legitimate zero-edit use cases:

1. **Exploration** — user asks to scan/audit a codebase
2. **Verification** — model runs tests and reports findings
3. **Q&A / research** — user asks questions about the code

The governor would fire "you haven't made any edits, stop looping" on
a model that was correctly doing what the user asked.

## Architecture: session phase FSM

The governor classifies each session into a phase based on the tool-call
event stream, then applies phase-specific rules with different budgets:

```
                    first_file_edit          build/test
  [Start] ──> EXPLORE ──────────> EDIT ──────────> VERIFY
                │                   │                  │
                │ completion        │ more edits       │ test failure
                │ signal            └──────┐           └──> EDIT
                v                          │
              REPORT <─────────────────────┘
                │                    tests pass,
                │                    no more work
                v
              [Done]
```

**Phase budgets:**

| Phase | Tool call budget | Key stall signal | Edit pressure |
|-------|-----------------|-------------------|---------------|
| Explore | 20+ calls | Redundant re-reads of same file | None |
| Edit | Normal | Failed edits, declaration without action | Yes |
| Verify | 6–10 calls | Repeated identical test/build commands | Low |
| Report | 1–2 calls | Any further exploration or verification | None |

Phase transitions are deterministic — based on tool call types, not LLM
text output. `consecutiveRecoveryFires` resets on phase transitions so
the hard stop counter doesn't carry across phases.

## Key mechanisms

### Investigation intent detection

`isReadOnlyInvestigationIntent(userText)` classifies the user's prompt
to determine if the session is inherently read-only. Two tiers:

- **Strong verbs** (always investigation): scan, audit, examine, inspect,
  survey, review, analyze, explain, describe, summarize
- **Weak verbs** (need completeness qualifier): verify, validate, check,
  assess, ensure, make sure — only count when combined with "every",
  "all", "implemented", "working", "complete", etc.

When investigation intent is detected, `isInvestigationOnly = true` and
`effectiveNoEditEvidence` becomes `false`, suppressing all edit-demanding
stall rules.

### Productive command detection

`isProductiveCommand(command, resultSignature)` identifies commands that
represent genuine work (not just exploration):

- Successful builds: `go build`, `cargo build`, `npm run build`, `make`
- Passing tests: `go test`, `pytest`, `npm test`, `vitest`
- Binary execution: `./binary --help`, `./binary --version`
- Git commits: `git add`, `git commit`, `git push`

Productive commands earn a threshold bonus on the `no_progress_loop`
rule (+1 each, max +4). They also cause `consecutiveRecoveryFires` to
decrement instead of increment, preventing the hard stop from firing
while the model is doing legitimate verification.

### Content-addressed dedup

`ContentAddressedDedup` hashes every file read and replaces re-reads
with compact stubs:

- First re-read: `<FILE_UNCHANGED ... />` + "you already have this file's
  content. Do NOT re-read it."
- Third+ re-read: `<FILE_READ_BLOCKED ... />` + hard block message

### Tool removal during stalls

When `exploration_stall_no_edit`, `no_progress_loop`, or
`verbal_intent_without_action` fires, the governor removes read/search
tools from the tool list: `read_file`, `read`, `search`, `grep`, `find`,
`list_dir`, `list_files`. The model physically cannot call them.

### Proactive file manifest

`FILES_ALREADY_READ` is injected into the system context on **every turn**
(not just during recovery), listing all files the model has already read.
This gives the model awareness of what it has without needing to re-read.

## Hard stop escalation

The governor uses a 5-tier escalation:

1. **Fire 1**: Inject recovery guidance as system message, restrict tools
2. **Fire 2–4**: Progressively stronger guidance, more tools removed
3. **Fire 5**: Hard stop — return a soft-fail response telling the model
   to act on what it has or report to the user

The hard stop includes the `FILES_ALREADY_READ` manifest so the model
knows exactly what information it already has.

## Research references

The phase-aware FSM approach is informed by:

- **SGH** (arXiv:2604.11378) — "From Agent Loops to Structured Graphs":
  proposes lifting control from implicit context into an explicit DAG
  with separated planning/execution/recovery layers. Key insight: the
  traditional agent loop's implicit dependencies cause unbounded recovery.

- **MI9** (arXiv:2508.03858) — "Integrated Runtime Governance for Agentic
  AI": introduces FSM-based conformance engines with goal-conditioned
  drift detection. Key insight: governance rules should change based on
  the current phase, not be a flat set applied uniformly. Achieved 99.81%
  detection rate with low false positives on 1,000 synthetic scenarios.

- **KAIJU** (arXiv:2604.02375) — "Executive Kernel for Intent-Gated
  Execution": decouples reasoning from execution through intent-gated
  dispatch. Key insight: classify intent once, then gate all subsequent
  actions against that intent.

The common thread across all three: **phase-aware governance** where
different rules apply in different execution phases, replacing the flat
"apply all rules always" approach.

## Files

| File | Role |
|------|------|
| `base/yarn-ts/src/governance/execution-governor.ts` | Rule evaluation, phase detection, recovery generation |
| `base/yarn-ts/src/index.ts` | Governor integration, hard stop, tool restriction |
| `base/yarn-ts/src/reduction/content-addressed-dedup.ts` | File read dedup, FILES_ALREADY_READ |
| `base/yarn-ts/tests/execution-governor.test.ts` | 84+ test cases |
