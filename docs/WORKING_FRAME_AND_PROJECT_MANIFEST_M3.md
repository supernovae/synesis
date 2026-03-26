# Working Frame + Project Manifest (Milestone 3)

This milestone improves context admission by adding two lightweight structures
before the model call:

- `WORKING_FRAME`: what we are doing right now
- `PROJECT_MANIFEST`: what kind of project/workflow we are in

These structures reduce ambiguity and prevent avoidable exploratory turns.

## Plain-language value

Without this layer, the model repeatedly re-derives task context from raw
conversation text. That costs tokens and can produce inconsistent behavior.

With this layer:

- we provide a compact current-task frame every request
- we provide inferred project/tooling context every request
- model decisions become more stable and fewer retries are needed

## What was added

### Core services

- `base/yarn-ts/src/frame/working-frame-service.ts`
  - builds `goal`, `constraints`, `activeFiles`, `currentPhase`,
    `pendingChecks`, and `openDecisions`
- `base/yarn-ts/src/project/project-manifest-service.ts`
  - infers language/tooling/test/lint profile from observed conversation content

### Runtime integration

- `base/yarn-ts/src/index.ts`
  - adds `enrichWithFrameAndManifest(...)` before model admission
  - prepends a compact system block containing:
    - `<WORKING_FRAME> ... </WORKING_FRAME>`
    - `<PROJECT_MANIFEST> ... </PROJECT_MANIFEST>`
  - exposes telemetry counters in `/health/telemetry`

### Config knobs

Added to `base/yarn-ts/src/config.ts`:

- `SYNESIS_YARN_WORKING_FRAME_ENABLED`
- `SYNESIS_YARN_PROJECT_MANIFEST_ENABLED`
- `SYNESIS_YARN_FRAME_MAX_FILES`

## Why this helps platform portability

This is interaction-pattern friendly and client-agnostic:

- IDE agents get better continuity across multi-turn edits
- CLI agents get tighter, phase-aware behavior with fewer redundant checks
- background/PR agents get clearer task/manifest context for deterministic plans

It works the same regardless of client brand because it lives in core runtime.

## Expansion paths

1. Replace heuristic extraction with structured hooks from tool pipeline
2. Add repository scanners for stronger manifest inference (package manager,
   language roots, CI commands)
3. Add policy-driven frame compaction and phase transitions
4. Add domain adapters (web, data, infra, mobile) as optional plugins
