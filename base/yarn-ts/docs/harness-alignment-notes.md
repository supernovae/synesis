# Harness Alignment Notes

This note captures external invariants adopted by Yarn's read-snapshot hardening.

## External patterns adopted

- OpenRouter-style tool flow: model suggests tool calls, client executes, tool results are fed back as explicit machine state.
- Vercel AI SDK-style guardrails: deterministic schema-shaped envelopes for tool results, not prose-only hints.
- Qwen/vLLM parser variability: do not rely on model inference from transport hints such as `Unchanged since last read`.
- Memory compaction practice: split "seen by client" from "still visible in active model context".

## Invariants implemented

- `client_read_seen[path]` remains advisory.
- `model_context_has_snapshot[snapshot_id]` is authoritative.
- Read tool outputs normalize to deterministic status envelopes:
  - `ok/full_content`
  - `ok/replayed_snapshot`
  - `ok/unchanged_snapshot_still_visible`
  - `needs_targeted_read`
  - `failed/snapshot_evicted`
- Compaction (`maybeCheckpoint` / `forceCheckpoint`) downgrades snapshot visibility state.

## Code mapping

- Snapshot state: `src/reduction/file-snapshot-registry.ts`
- Shared normalization: `src/reduction/read-snapshot-normalizer.ts`
- Claude/OpenAI integration: `src/index.ts`
- Dedup compatibility with envelopes: `src/reduction/content-addressed-dedup.ts`
- Governor no-op recognition for typed unchanged state: `src/governance/execution-governor.ts`

