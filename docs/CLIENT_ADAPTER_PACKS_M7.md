# Client Adapter Packs (Milestone 7)

Milestone 7 adds adapter packs that map clients into interaction patterns.

## Plain-language value

We do not hardwire behavior only by product brand.
Instead, we classify clients by interaction mode:

- IDE interactive
- CLI/terminal
- background/PR
- MCP-native

This makes behavior portable while still letting each client get a better fit.

## What was implemented

### Core adapter service

- `base/yarn-ts/src/adapters/client-adapter-packs.ts`
  - resolves `client + mode` into a profile
  - produces a compact `<CLIENT_ADAPTER>` system block
  - tracks mode-resolution stats

### Runtime integration

- `base/yarn-ts/src/index.ts`
  - reads optional headers:
    - `x-synesis-client`
    - `x-synesis-mode`
  - injects adapter profile into model admission context
  - exposes adapter catalog endpoint:
    - `GET /v1/adapter-packs`
  - includes adapter stats in `/health/telemetry`

### Tests

- `base/yarn-ts/tests/client-adapter-packs.test.ts`

## Why this helps platform value

- one runtime can serve many clients without bespoke forks
- keeps deterministic policy and context design consistent
- allows future per-mode tuning while preserving portability

## Expansion paths

1. Add richer mode-specific budgets and tool policies
2. Add capability negotiation (tool depth, streaming style, response verbosity)
3. Add per-client analytics in Session Intelligence dashboard
4. Add adapter presets delivered from admin configuration
