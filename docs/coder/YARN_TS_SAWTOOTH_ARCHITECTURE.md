# Yarn TS Sawtooth Architecture (Node 22 + AI SDK Core)

This document defines the first-pass TypeScript orchestration architecture for Yarn, using Vercel AI SDK Core with a direct `customProvider` dependency and Synesis-specific policy layers.

## Token Efficiency Model

Without consolidation, context growth is approximately linear:

$$
C_t = C_0 + \sum_{i=1}^{t}\Delta_i \in O(n)
$$

With sawtooth checkpointing and pruning every \(k\) tool steps:

$$
C_t \le C_{max} \approx C_{active} + C_{checkpoint} \in O(1)
$$

where:
- \(C_{active}\): bounded active working set,
- \(C_{checkpoint}\): compressed architectural state block.

## Runtime Layers

1. **Protocol Layer**  
   OpenAI-compatible and Claude-compatible endpoints validate payloads via Zod.

2. **Provider Layer (AI SDK Core)**  
   `customProvider` maps Synesis tier IDs to upstream OpenAI-compatible providers.

3. **State Layer (Sawtooth Context Manager)**  
   Maintains active trajectory, checkpoint decisions, and compression outputs.

4. **Safety Layer**  
   Repeat-loop pivot protocol and patch-first enforcement.

## Sawtooth Checkpointing Rules

- `toolCallsSinceCheckpoint` increments for every tool-result message received (both OpenAI and Claude paths).
- User and assistant messages are appended to `session.history` on every request (including streaming paths).
- Trigger consolidation every 10-12 tool calls (configurable via `SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS`), or when history exceeds 60 entries.
- Summarize recent trajectory into a strict `<ARCHITECTURAL_STATE>` block using the compaction model (`synesis-compaction` tier) or fall back to a heuristic (last 20 messages).
- On subsequent requests, any compacted `<ARCHITECTURAL_STATE>` block is injected as the first system message, giving the model continuity without unbounded context growth.
- Replace verbose logs with masked form:
  - keep first 10 and last 10 lines,
  - suppress middle payload.

### Telemetry

The `/health/telemetry` endpoint exposes `sawtoothContext`:
- `activeSessionCount`: in-memory sessions
- `totalHistoryEntries`: sum of all history array lengths
- `checkpointedSessions`: sessions with at least one compaction
- `checkpointThreshold`: configured tool-call trigger value

## Extension-Based Heuristics

Language-specific log and artifact handling is extension-driven, not framework-driven.
The baseline includes common extensions (TS/JS/Python/Go/Rust/Java/Terraform/SQL/YAML, etc.) and can be extended per domain.

## Safety Fencing

- N-repeat guard on normalized `(tool, args, fsFingerprint)` triplets.
- On 3 repeats without filesystem mutation, force Hard Pivot strategy response.
- Reject full-file `write_file` style operations in favor of `apply_patch`/search-replace for non-trivial edits.

## Compatibility Goals

- Keep admin as source of truth for model/provider metadata.
- Preserve tier IDs and client-facing model contract (`synesis-pulse`, `synesis-core`, `synesis-horizon`).
- Maintain MCP compatibility and streaming behavior parity over time.
