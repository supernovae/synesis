# Harness Card v1

Harness Card v1 describes model-family behavior for the upper harness. It is
not a safety policy and it is not a replacement for provider API docs.

The intent is to let model providers, Synesis maintainers, and contributors
describe how a model behaves under tool use so the Master Harness can apply the
right repairs, nudges, and validation without turning the runtime into
model-specific spaghetti.

## Shape

```yaml
schema_version: synesis_harness_card_v1
id: qwen3-coder
display_name: Qwen3 Coder
model_match:
  family_prefixes: [qwen, qwen3]
  model_substrings: [qwen3-coder, qwen-coder]
  provider_hints: [dashscope, vllm, openrouter]
capabilities:
  supports_thinking: false
  native_tool_parser: false
  max_effective_tools: 40
  strict_json: low
  strict_tool_args: low
repairs:
  empty_arguments: normalize_to_empty_object
  malformed_json: conservative
  argument_aliases:
    Bash:
      cmd: command
    Read:
      path: file_path
loop_controls:
  repeated_tool_dampening: true
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
