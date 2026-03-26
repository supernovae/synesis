# Phase and Model Orchestrator (Milestone 5)

Milestone 5 adds phase-aware model selection and output budgeting.

## Plain-language value

Before:
- model tier choice mostly followed explicit request/default
- validation-heavy turns could use larger models than needed

After:
- runtime infers workflow phase (`planning`, `implementation`, `validation`)
- runtime picks an effort tier based on risk + phase
- runtime applies output token budget per tier

This gives faster low-risk validation loops while preserving depth for high-risk
or complex planning work.

## What was implemented

### Core service

- `base/yarn-ts/src/orchestration/phase-model-orchestrator.ts`
  - determines phase from latest user intent
  - selects tier (`synesis-pulse`, `synesis-core`, `synesis-horizon`)
  - returns budget (`maxOutputTokens`) and decision reasons
  - tracks decision stats

### Runtime integration

- `base/yarn-ts/src/index.ts`
  - OpenAI path now runs orchestrator before provider resolution
  - Claude path now runs orchestrator before provider resolution
  - `maxOutputTokens` applied in both streaming and non-streaming calls
  - telemetry now includes `phaseOrchestrator` stats

## Why this helps the platform

- lower latency and token cost for validation loops
- safer escalation for high-risk tasks
- more predictable behavior across client interaction patterns

## Expansion paths

1. Use Working Frame + Manifest directly as orchestrator input object
2. Add per-client mode routing profiles (IDE, CLI, PR/background)
3. Add cost-aware routing against live model pricing/capacity
4. Add phase transition telemetry to admin Session Intelligence dashboard
