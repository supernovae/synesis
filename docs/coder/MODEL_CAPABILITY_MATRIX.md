# Model Capability Matrix

This document defines the canonical capability matrix contract used by
`yarn-ts`, `planner-ts`, and `webui`.

The design goal is:

- global safety switch for all advanced optimizations
- explicit opt-in overrides by model family/path/name
- deterministic precedence and traceability

## Matrix Document Schema (v1)

```json
{
  "version": 1,
  "mode": "enforced",
  "global_optimizations_enabled": false,
  "overrides": [
    {
      "id": "policy-abc123",
      "enabled": true,
      "selector_type": "family_prefix",
      "selector": "qwen3",
      "priority": 10,
      "capabilities": {
        "yarn.reducers_enabled": true
      }
    }
  ]
}
```

### Fields

- `version`: integer schema version (`1` for this contract).
- `mode`:
  - `enforced`: apply resolved capabilities.
  - `shadow`: compute and trace resolved capabilities, but do not enforce.
- `global_optimizations_enabled`:
  - `false`: all capabilities default `false` unless enabled by matching override.
  - `true`: all capabilities default `true` unless disabled by matching override.
- `overrides`: override rows.

### Override Row

- `id`: stable identifier (typically the backing governance `policy_id`).
- `enabled`: disabled rows are ignored.
- `selector_type`:
  - `exact_model`
  - `model_path_prefix`
  - `family_prefix`
- `selector`: case-insensitive selector value.
- `priority`: higher numbers win for conflicts at the same selector tier.
- `capabilities`: map of capability key -> boolean.

## Selector Inputs

Resolvers consume:

- `model_id` (required)
- `model_path` (optional)
- `family` (optional)

## Precedence Rules

1. Global default (`global_optimizations_enabled`)
2. `family_prefix` overrides
3. `model_path_prefix` overrides
4. `exact_model` overrides

Conflict resolution inside the same tier:

1. higher `priority` first
2. lexical `id` tie-breaker (stable deterministic behavior)

## Capability Keys (v1)

- Yarn
  - `yarn.reducers_enabled`
  - `yarn.transcript_prune_enabled`
  - `yarn.phase_execution_policy_enabled`
  - `yarn.json_compaction_enabled`
  - `yarn.content_dedupe_enabled`
  - `yarn.response_dedupe_enabled`
  - `yarn.historical_normalize_enabled`
- Planner
  - `planner.context_optimizer_enabled`
- WebUI
  - `webui.builtin_tools_enabled`
  - `webui.file_context_enabled`

Resolvers must ignore unknown capability keys and never throw.

## Resolution Output Contract

Resolvers return:

- `mode`
- `global_optimizations_enabled`
- `resolved_capabilities` (normalized key -> boolean)
- `matched_override_ids` (ordered by application)
- `matched_selectors` (metadata for diagnostics)

## Shared Fixtures

Resolver fixtures live at:

- `docs/coder/capability-matrix-resolver-fixtures.json`

All language implementations must pass those fixtures.

## Rollout Guidance

See `docs/coder/MODEL_CAPABILITY_MATRIX_RUNBOOK.md` for shadow/enforce stages,
rollback procedure, and operational checks.
