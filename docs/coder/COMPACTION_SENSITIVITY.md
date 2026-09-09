# Compaction policy and failure evidence

Synesis Yarn uses configured reduction, retention and checkpoint limits across model families. Backend model names do not silently change those limits. The filename is retained for existing links; the former Qwen/MiniMax sensitivity classifier has been removed.

## Common behavior

- Tool-result reduction uses the configured profile and character caps. The latest detected verification failure receives bounded protection for every model, so reduction does not erase the immediate reason a task failed.
- Transcript pruning uses the configured token budget and recent-tool window, with the existing common small-project budget floor and protected-message rules.
- Sawtooth checkpoints use configured runtime-mode thresholds. The compaction prompt asks for current failure evidence, exact paths and recovery references; it does not promise lossless transcript storage.
- Model routing metadata remains available for diagnostics. It does not select a hidden retention multiplier.

Relevant controls include `SYNESIS_YARN_REDUCER_PROFILE`, `SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS` and `SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS`. Existing deployments previously receiving a family-based increase now use their configured limits. Re-evaluate those limits against the actual workload if necessary.

Explicit, measured architecture registry overrides are separate from these removed name heuristics; see [architecture controls](../model-architecture-awareness.md#admin-overrides). Client-side compaction remains a client operation: Synesis detects transcript drops and resets dedup state rather than rewriting client summaries.

## Model qualification

Failure-evidence retention does not establish prompt-injection resistance. Qualify evidence-bearing routes using [trust policy model compliance](TRUST_POLICY_MODEL_COMPLIANCE.md), and retain deterministic trust boundaries across families. See the [model compatibility guide](../model-compatibility.md) for model and endpoint distinctions.

## Implementation

- [Compaction prompt and failure detection](../../base/yarn-ts/src/context/compaction-sensitivity.ts)
- [Sawtooth manager](../../base/yarn-ts/src/context/sawtooth-manager.ts)
- [Tool-result reducer](../../base/yarn-ts/src/reduction/tool-result-reducer.ts)
- [Transcript pruning](../../base/yarn-ts/src/reduction/transcript-pruning.ts)
