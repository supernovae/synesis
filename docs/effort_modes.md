# Effort Modes for General Front-End Flows

This document defines the effort-mode abstraction for user-facing planner flows.

## User-Facing Contract

- `auto`
- `pulse`
- `core`
- `horizon`

These are capability contracts, not fixed provider/model identifiers.

## Architecture

1. Presentation layer
   - Clients choose effort mode (`auto` by default).
   - Raw provider/model remains implementation detail.

2. Routing policy layer
   - `entry_pipeline` computes Auto recommendation using existing classifier/taxonomy/frame signals.
   - Routing is bounded and deterministic (no unbounded regex/rule machinery).
   - Confidence gate falls back to `core` when recommendation confidence is low.

3. Orchestration layer
   - Shared graph remains intact.
   - `execution_policy` is injected into state and consumed by nodes/routing.
   - Current first-pass policy influence:
     - retrieval depth in router
     - critique pass cap in critic routing

4. Model/provider layer
   - Admin roles now include:
     - `general-pulse`
     - `general-core`
     - `general-horizon`
   - Planner model resolution maps `general` calls to effort-specific roles when selected.
   - If effort-specific mapping is unavailable, planner falls back to static defaults while preserving effort-mode contract.

## Backward Compatibility

- Legacy IDs `Synesis` and `Synesis Thinking` remain available.
- New IDs are also exposed:
  - `Synesis Auto`
  - `Synesis Pulse`
  - `Synesis Core`
  - `Synesis Horizon`
- Existing clients keep working while newer clients can adopt effort modes directly.

