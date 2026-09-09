# Transcript prune: safe context for agents

Synesis [`TranscriptPruningService`](../../base/yarn-ts/src/reduction/transcript-pruning.ts) reduces large client histories before the model sees them. Defaults are in [`config.ts`](../../base/yarn-ts/src/config.ts) under `SYNESIS_YARN_TRANSCRIPT_PRUNE_*`.

## Environment knobs

| Variable | Role |
|----------|------|
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_ENABLED` | Master switch |
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TURNS` | Retention window by user-turn count (exact deduplication may still apply) |
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TOOL_RESULTS` | Fallback window by tool-result count (single-turn agent loops) |
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_BUDGET_CHARS` | Prune only when transcript exceeds this size |
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_STUB_MAX_CHARS` | Max size of a stub replacing an evicted tool body |
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_ASSISTANT_CONDENSE_CHARS` | Old assistant trim threshold |

Raise `KEEP_TOOL_RESULTS` or `BUDGET_CHARS` when sessions are long but you still need older literals.

## Code-level protections

- **Failing verification / build output**: the last few shell tool results that match `looksLikeVerificationFailureOutput` (see [`compaction-sensitivity.ts`](../../base/yarn-ts/src/context/compaction-sensitivity.ts)) are **never** replaced by `TOOL_RESULT_PRUNED` stubs, so compile/test stderr stays readable.
- **Exact-output collapse**: compare complete byte-identical outputs. Digits and unsampled lines are not discarded when deciding identity. Existing protected-result rules still apply.
- **Current-turn read working set**: in single-user-turn agent loops, transcript pruning keeps a bounded set of recent read literals from the active turn so `keepToolResults` fallback does not evict code the agent just read.
- **Configured keep window**: transcript budgets and `keepToolResults` follow configuration for every model family. Recent failure evidence receives common protection; model names do not silently enlarge retention windows.

Structured assistant reasoning and tool-call parts are preserved during transcript
condensation. Compaction stubs and artifact handles are references, not a promise
that all source content remains visible. Recover needed literals through the
available artifact/read tools. Reduction ratios and task quality depend on the
transcript; the implementation does not guarantee lossless compaction.
