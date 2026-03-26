# Tool Result Reduction + Artifact Handles (Milestone 2)

This milestone extends M1 so we do not only normalize validation logs.  
We now reduce oversized tool results in general and pass concise envelopes to the model.

## Plain-language summary

Before:
- agents often forwarded huge tool outputs into context
- token usage spiked even when only a small part was needed

After:
- oversized tool results are replaced with a compact summary
- raw payload is stored behind an `artifact_handle`
- model sees the important signal, not the full raw dump

## What was implemented

### Core runtime

- `base/yarn-ts/src/reduction/tool-result-reducer.ts`
  - detects oversized `role=tool` messages
  - emits `<TOOL_RESULT_SUMMARY ...>` envelopes
  - writes raw payload to artifact storage
- `base/yarn-ts/src/state/artifact-store.ts`
  - now supports both `validation-output` and `tool-result` artifact kinds
- `base/yarn-ts/src/tool-mapping.ts`
  - `claudeMessagesToOpenAI` now accepts optional tool-result reducer callback
  - allows reduction of Claude `tool_result` blocks before model admission
- `base/yarn-ts/src/index.ts`
  - OpenAI path: tool-result reduction runs before validation normalization
  - Claude path: reducer callback applied while adapting content blocks
  - telemetry now includes `toolResultReduction` stats
  - artifact fetch endpoint uses shared artifact store

## Why this helps the platform

- lowers token and latency overhead for tool-heavy sessions
- improves consistency across clients (Claude Code, Cursor, Continue, Cline, Roo, etc.)
- keeps portability by enforcing a common runtime envelope format
- prepares the foundation for deterministic direct responses (skip LLM when safe)

## Expansion paths

1. Add tool-specific reducers (`ripgrep`, `git diff`, `pytest -vv`, `npm test`, `go test`, etc.)
2. Add severity/risk tags to envelopes for routing and policy decisions
3. Route to deterministic responses when envelope indicates clear next action
4. Persist artifacts in Redis/object storage for multi-replica durability
5. Add per-client formatting profiles (IDE, CLI, PR/background)

## Success metrics

- `toolResultReduction.reducedCount`
- `toolResultReduction.artifactHandleCount`
- `toolResultReduction.tokensSavedEstimateTotal`
- lower average admitted chars per request for tool-heavy sessions
