# Synesis Planner Workflow (TypeScript)

This is the canonical workflow document for the active planner runtime:
`base/planner-ts/`.

It supersedes legacy planner workflow notes that referenced Python planner code.

## Scope

- Runtime: `base/planner-ts/`
- API entrypoint: `base/planner-ts/src/app.ts`
- Graph wiring: `base/planner-ts/src/graph.ts`
- Node logic: `base/planner-ts/src/pipeline.ts` and `base/planner-ts/src/nodes/*`

## Canonical Graph

The planner graph is wired in `base/planner-ts/src/graph.ts` with these nodes:

1. `entry_pipeline`
2. `planner`
3. `plan_gate`
4. `router`
5. `writer`
6. `critic`
7. `final_scrubber`
8. `respond`

Primary flow:

`entry_pipeline -> planner -> plan_gate -> router -> writer -> [critic|final_scrubber] -> respond`

Key conditional loops:

- `critic -> router` for evidence gaps
- `critic -> writer` for writing revision
- `critic -> final_scrubber` for terminalization / anti-oscillation / max-iteration
- `plan_gate` currently routes to `respond` or `router` only (no graph-level retry edge back to `planner`)

## Node Responsibilities

- `entry_pipeline`
  - Runs deterministic entry classification (`classifyEntry`)
  - Runs optional frame extraction (`frameExtractorNode`) for non-trivial tasks
  - Sets routing and policy signals (`difficulty`, `rag_mode`, `plan_required`, etc.)

- `planner`
  - Produces execution plan (LLM path via `runLlmPlanner`, deterministic fallback)
  - Handles clarification gating and plan confidence
  - Emits planner decisions to the decision ledger

- `plan_gate`
  - Deterministic plan validation and repair feedback
  - Decides whether to continue planning, respond, or proceed to retrieval

- `router`
  - **Single retrieval orchestrator**
  - Executes retrieval via `runRouter` and retrieval client
  - Owns evidence packet production and retrieval policy routing

- `writer`
  - Produces the user-facing markdown draft
  - Supports streamed and non-streamed composition paths

- `critic`
  - Evaluates draft quality and evidence sufficiency
  - Routes to `router`, `writer`, `final_scrubber`, or `respond` based on verdict

- `final_scrubber`
  - Removes internal scaffolding
  - Appends optional closing follow-up prompt

- `respond`
  - Final state handoff for API response emission

## Streaming and Request Handling

In `base/planner-ts/src/app.ts`:

- OpenAI-compatible route: `POST /v1/chat/completions`
- Non-stream path executes full graph and returns final chunk
- Stream path emits SSE updates while graph executes
- Optional fast path: `directStreamPipeline` for trivial/no-RAG scenarios

## Retrieval Invariant

Retrieval is router-governed. Only router code invokes retrieval clients and builds
evidence packets consumed downstream.

## State and Safety

State type is `GraphState` (`base/planner-ts/src/state/types.ts`), with graph updates
assembled by node transitions in `graph.ts` and node implementations in `pipeline.ts`.

Implementation guardrails:

- Planner/critic/writer validation wrappers in `pipeline.ts` (`validatedNode`)
- Node timeout wrapper in `graph.ts` (`runNodeWithTimeout`)
- Router-only retrieval ownership preserved in routing and node responsibilities

## Config (Planner TS)

Planner runtime config is loaded from `base/planner-ts/src/config.ts`.
All planner-specific runtime toggles use `SYNESIS_PLANNER_TS_*` variables.

Notable groups:

- LLM runtime / retries / timeouts
- Writer and critic token budgets
- Node timeout and stream admission controls
- Session and Redis config
- Retrieval / web-search / taxonomy config

## Notes on Legacy References

Older docs may still mention Python planner paths (for example `graph.py`,
`main.py`, or Python node modules). Those are historical references and are not the
active planner runtime.

Use this document and `base/planner-ts/` source files as the source of truth.
