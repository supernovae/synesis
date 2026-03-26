# Validation Normalization (Milestone 1)

This document explains the first implementation in simple terms.

## What problem this solves

Coding agents often paste raw validator/test output directly into model context.  
That wastes tokens and hides the important part (what failed, where, and how to fix it).

Milestone 1 adds a normalization layer that:

- detects validation-like tool output
- extracts concise findings
- passes a compact summary to the model
- stores oversized raw output behind an artifact handle

This is a pre-admission optimization. It reduces waste before compaction.

## What was added

### Core runtime pieces

- `base/yarn-ts/src/validation/types.ts`
  - shared interfaces for findings and envelopes
- `base/yarn-ts/src/validation/normalizer.ts`
  - parsers for common patterns (`tsc`, `ruff`, `eslint`, `pytest`)
- `base/yarn-ts/src/validation/admission-policy.ts`
  - applies limits and decides when to emit artifact handles
- `base/yarn-ts/src/state/artifact-store.ts`
  - in-memory handle store for oversized raw payloads
- `base/yarn-ts/src/validation/service.ts`
  - orchestrates detection, normalization, admission policy, and telemetry counters

### Runtime integration

- `base/yarn-ts/src/index.ts`
  - normalizes request messages before model admission (OpenAI and Claude paths)
  - exposes normalization stats in `/health/telemetry`
  - exposes artifact retrieval endpoint `/v1/artifacts/:id`

### Configuration knobs

Added to `base/yarn-ts/src/config.ts`:

- `SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS`
- `SYNESIS_YARN_VALIDATION_MAX_FINDINGS`
- `SYNESIS_YARN_VALIDATION_INCLUDE_RAW`

## How this can be expanded

1. Add more parser adapters (`go test`, `cargo`, `jest`, `mypy`, `clang`, etc.)
2. Persist artifacts in Redis/object storage for multi-replica retrieval
3. Add deterministic response patterns for known validator families (skip LLM when safe)
4. Add per-client render profiles (IDE diagnostics vs CLI summary vs PR report)
5. Add policy-driven escalation thresholds (when to call LLM vs respond directly)

## Why this matters

- fewer tokens sent upstream
- faster response times on validation-heavy loops
- clearer and more actionable error summaries
- better portability across Claude Code, Cursor, VS Code/Copilot, Continue, Cline, Roo, and others
