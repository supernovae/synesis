# Agent Orchestration (Phase 3)

This document describes the request/response multi-agent orchestration runtime used by Yarn MCP `delegate_task`.

## Goals

- Deterministic supervisor as source of truth.
- Bounded role execution: Planner, Worker, Reviewer.
- Request/response only (no durable async jobs yet).
- Trace-first artifacts (`trace_id`, `artifact_id`) for inspectability.
- Narrow repo operations; worker prompts do not receive all tools.

## Module Map

- Shared package: `packages/synesis-agent-orchestration`
  - `schemas.ts`: Zod contracts for plan/task/result/decision/review/trace/artifacts
  - `runtime.ts`: `RequestResponseRuntime` + orchestration control flow
  - `planner.ts`: Cynefin-like intake and structured plan generation
  - `worker.ts`: budget-bounded worker execution contract
  - `reviewer.ts`: final acceptance/remand checks
  - `policy-engine.ts`: merge safety, full-file rewrite policy, overlap checks
  - `compaction.ts`: instruction normalization and context compaction
  - `artifact-store.ts` / `trace.ts`: first-class trace and artifact abstractions
  - `repo-ops.ts`: typed repo operation IDs and guarded adapter

- Yarn integration:
  - `base/yarn-ts/src/mcp/handlers/coding-tools.ts`
    - `delegate_task` now invokes request/response runtime.
    - Adds typed repo MCP handlers: `repo.search`, `repo.read_range`, `repo.find_symbol`,
      `repo.apply_patch`, `repo.run_tests`, `repo.run_lint`, `repo.git_diff`,
      `repo.list_changed_files`, `repo.write_decision_record`.
  - `base/yarn-ts/src/mcp/index.ts`
    - Dynamic MCP exposure for agent-only tools.
    - Agent-only tools require `x-synesis-agent-flow` header.

## Safety Constraints

- No recursive spawn.
- Max parallel workers: 3.
- Max planner rounds: 2.
- Max repair rounds: 1.
- Architectural challenge flow is bounded (1 challenge + 1 adjudication policy target).
- Full-file rewrites rejected unless explicit override.
- Overlapping worker edits escalate and stop merge.
- Migration/schema/destructive indicators require clarification/escalation.

## Current Scope

- Implemented request/response supervisor boundary and typed artifacts.
- Implemented dynamic agent-only MCP tool exposure.
- Durable long-running orchestration is intentionally deferred.
