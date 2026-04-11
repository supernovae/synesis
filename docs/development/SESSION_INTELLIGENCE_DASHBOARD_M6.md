# Session Intelligence Dashboard (Milestone 6)

Milestone 6 adds practical operator visibility into how coding sessions behave,
not just how many requests were made.

## Plain-language value

Before:
- Yarn overview focused on totals (requests, latency, cost)
- hard to see whether sessions were healthy, loop-prone, or token-efficient

After:
- Yarn overview includes a Session Intelligence section with:
  - average tool calls per request
  - cache hit estimate
  - tool-use stop rate
  - error-like finish rate
  - top active models
  - finish-reason distribution

This makes it easier to tune runtime policies and prove value from M1-M5.

## What was implemented

### Backend API

- `base/admin/app/services/yarn_service.py`
  - added `get_yarn_intelligence(...)` aggregation over `yarn_usage_log`
- `base/admin/app/routers/yarn.py`
  - added `GET /api/v1/yarn/intelligence`

### Frontend

- `base/admin/frontend/src/api/hooks.ts`
  - added `useYarnIntelligence(sinceHours)` and `YarnIntelligence` type
- `base/admin/frontend/src/pages/yarn/YarnOverview.tsx`
  - added Session Intelligence dashboard panels

## Why this helps platform development

- enables data-driven policy tuning (patch-first, anti-loop, phase routing)
- shows whether reductions actually improved behavior
- supports portability strategy by comparing interaction-pattern outcomes over time

## Expansion paths

1. Split intelligence by interaction mode (IDE, CLI, PR/background)
2. Add per-client adapter segment metrics (Claude/Cursor/etc. without forking logic)
3. Add trend charts for intelligence KPIs by time bucket
4. Correlate intelligence metrics with cost and failure events in one view
