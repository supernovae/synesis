# Effort Modes for Writer Front-End Flows

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
     - `writer-pulse`
     - `writer-core`
     - `writer-horizon`
   - Planner model resolution maps user-facing effort modes to writer roles.
   - If effort-specific mapping is unavailable, planner uses the base `writer` role while preserving the effort-mode contract.

## Public Model IDs

- Exposed planner IDs:
  - `Synesis Auto`
  - `Synesis Pulse`
  - `Synesis Core`
  - `Synesis Horizon`
