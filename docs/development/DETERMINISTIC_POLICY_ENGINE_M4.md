# Deterministic Policy Engine (Milestone 4)

Milestone 4 unifies request safety checks into a single ordered policy engine.

## Plain-language value

Before:
- patch-first and loop checks were separate pieces
- behavior could drift as more checks were added

After:
- one deterministic evaluator applies rules in order
- each request gets explainable rule outcomes
- telemetry shows how often rules reject or pivot work

This improves reliability and portability across all client patterns.

## What was implemented

### Core service

- `base/yarn-ts/src/policy/deterministic-policy-engine.ts`
  - Patch-first rule: reject `write_file`
  - Repeat-loop rule: inject pivot prompt on 3rd repeated attempt
  - Structured decision output:
    - `allow`
    - `rejectReason`
    - `pivotPrompt`
    - `matchedRules`
  - Runtime stats:
    - evaluations
    - rejectedCount
    - pivotCount

### Runtime integration

- `base/yarn-ts/src/index.ts`
  - OpenAI route (`/v1/chat/completions`) now uses deterministic policy precheck
  - Claude route (`/v1/messages`) now uses deterministic policy precheck
  - Pivot prompt (when triggered) is injected into session history
  - `/health/telemetry` now includes `deterministicPolicy` stats

## Why this helps platform value

- stable and predictable safety behavior across Claude Code, Cursor, Continue,
  Cline, Roo, and other clients
- fewer unnecessary loop retries
- clearer operator visibility into policy actions

## Expansion paths

1. Add policy rules for context admission limits by mode
2. Add risk-profile based rule sets (`low`, `standard`, `high`)
3. Add policy trace IDs for per-request explainability in admin dashboards
4. Add per-client mode profiles (IDE, CLI, PR/background) without forking logic
