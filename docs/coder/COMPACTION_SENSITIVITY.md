# Compaction sensitivity (Qwen3-Coder)

Synesis yarn-ts adjusts **server-side** compaction and tool-result reduction based on the **tier-resolved backend model** string (from admin tier registry), not only global env vars.

## Behavior

| Sensitivity | Trigger (backend model id / name) | Tool reduction | Sawtooth checkpoint |
|-------------|-----------------------------------|------------------|----------------------|
| `strict_literals` | Substrings `coder-next`, `qwen3-coder-next`, `qwen3.6-coder-next` | Demotes `aggressive`/`ultra` reducer profile to `balanced`, raises `maxChars`, preserves **verbatim** the last failing verification tool result (bounded), uses a larger transcript-prune budget and keep-tool window, stricter compaction LLM prompt | Checkpoints later (higher tool-call and history thresholds) |
| `qwen_coder` | Regex `qwen3.*coder` (excluding strict cases above) | Demotes aggressive/ultra to `balanced`, moderate `maxChars` bump, gentler transcript-prune keep window/budget | Slightly later checkpoints |
| `default` | Everything else | Uses `SYNESIS_YARN_REDUCER_PROFILE` and `SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS` as configured | Default `SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS` and history length 60 |

Session Redis metadata key: `synesis_compaction_backend_model` (set each request from orchestrated tier).

## Ops overrides

Global knobs still apply as baselines:

- `SYNESIS_YARN_REDUCER_PROFILE` — `balanced` is safest for noisy tool logs.
- `SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS` — raised further when sensitivity applies.
- `SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS` — base value scaled per sensitivity for fragile models.

Client-side `/compact` (Claude Code, etc.) is unchanged: Synesis only detects large transcript drops and resets dedup; it does not rewrite client summaries.

## Code

- [base/yarn-ts/src/context/compaction-sensitivity.ts](../base/yarn-ts/src/context/compaction-sensitivity.ts)
- [base/yarn-ts/src/context/sawtooth-manager.ts](../base/yarn-ts/src/context/sawtooth-manager.ts)
- [base/yarn-ts/src/reduction/tool-result-reducer.ts](../base/yarn-ts/src/reduction/tool-result-reducer.ts)
