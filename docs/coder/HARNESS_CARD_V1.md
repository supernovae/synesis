# Harness Card v1

Harness Card v1 describes model-family behavior for the upper harness. It is
not a safety policy and it is not a replacement for provider API docs.

The intent is to let model providers, Synesis maintainers, and contributors
describe how a model behaves under tool use so the Master Harness can apply the
right repairs, nudges, and validation without turning the runtime into
model-specific spaghetti.

## Matching and evidence

Built-in matching prefers exact model IDs, then the most specific model
substring, then family hints. Provider-only fallback must be unique. A shared
OpenRouter or vLLM endpoint does not identify the model or prove its tool parser
configuration. See [the current built-in cards](../../packages/synesis-upper-harness/src/cards.ts).

The example below describes original Qwen3 Coder, not Coder Next or Qwen
reasoning models. Built-in cards do not impose unmeasured tool-count limits or
nudge solely because tool names repeat. Keep any custom overrides explicit and
validate them against the actual endpoint and client schema. The
[model compatibility guide](../model-compatibility.md) documents these boundaries.

## Shape

```yaml
schema_version: synesis_harness_card_v1
id: qwen3-coder
display_name: Qwen3 Coder
model_match:
  family_prefixes: [qwen3-coder]
  model_substrings: [qwen3-coder, qwen-coder]
  provider_hints: []
capabilities:
  supports_thinking: false
  native_tool_parser: false
  strict_json: medium
  strict_tool_args: medium
repairs:
  empty_arguments: preserve
  malformed_json: conservative
  argument_aliases:
    Bash:
      cmd: command
    Read:
      path: file_path
loop_controls:
  repeated_tool_dampening: false
  plan_no_action_limit: 2
  edit_retry_limit: 2
sampling_defaults:
  temperature: 0.7
  top_p: 0.95
```

## Card vs Plugin

Use a card for declarative behavior:

- matching model ids and providers
- argument aliases
- parser tolerance
- tool count limits
- loop-control thresholds
- sampling defaults

Use a plugin for behavior that needs code:

- non-trivial malformed output repair
- nuanced repeated-tool detection
- provider-specific request shaping
- custom diagnostics or model-family experiments

Plugins are optional. A provider can publish a useful card without shipping
runtime code.

## Card vs Master Harness

Cards must not define permission policy.

The following always belong to the Master Harness:

- dangerous shell blocking
- path sandbox policy
- write-capable tool policy
- stale-write blocking
- token budget hard limits
- trace schema
- release gates and scorecards

Cards may help the Master Harness see intent correctly. For example, a card may
repair `cmd` to `command`; the Master Harness then evaluates the repaired
command and blocks it if it is unsafe.

## Acceptance Criteria for a New Card

A new card must include:

- model matching rules
- strictness and parser assumptions
- known safe argument aliases
- at least one simulated loop or tool-call test
- documentation of any plugin hooks

Live bakeoffs are encouraged and should be stored as scorecards, but they are
not required for every pull request.
