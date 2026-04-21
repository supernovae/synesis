# Transcript prune: safe context for agents

Synesis [`TranscriptPruningService`](../../base/yarn-ts/src/reduction/transcript-pruning.ts) shrinks client-huge histories before the model sees them. Defaults are in [`config.ts`](../../base/yarn-ts/src/config.ts) under `SYNESIS_YARN_TRANSCRIPT_PRUNE_*`.

## Environment knobs

| Variable | Role |
|----------|------|
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_ENABLED` | Master switch |
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TURNS` | Full-fidelity window by user-turn count |
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TOOL_RESULTS` | Fallback window by tool-result count (single-turn agent loops) |
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_BUDGET_CHARS` | Prune only when transcript exceeds this size |
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_STUB_MAX_CHARS` | Max size of a stub replacing an evicted tool body |
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_ASSISTANT_CONDENSE_CHARS` | Old assistant trim threshold |

Raise `KEEP_TOOL_RESULTS` or `BUDGET_CHARS` when sessions are long but you still need older literals.

## Code-level protections

- **Failing verification / build output**: the last few shell tool results that match `looksLikeVerificationFailureOutput` (see [`compaction-sensitivity.ts`](../../base/yarn-ts/src/context/compaction-sensitivity.ts)) are **never** replaced by `TOOL_RESULT_PRUNED` stubs, so compile/test stderr stays readable.
- **Near-duplicate collapse**: outputs that fingerprint the same but differ on pass vs fail heuristics are not collapsed into each other.
- **Current-turn read working set**: in single-user-turn agent loops, transcript pruning keeps a bounded set of recent read literals from the active turn so `keepToolResults` fallback does not evict code the agent just read.
- **Model-sensitive keep window**: Qwen coder families automatically get a larger transcript budget and `keepToolResults` window, reducing over-eviction without globally disabling pruning.
