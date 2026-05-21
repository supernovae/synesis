# Master Harness

The Master Harness is the model-agnostic control layer for Synesis Yarn. It is
where systemic behavior lives: safety, token budgets, tracing contracts, and
cross-model tool governance.

Model-specific behavior belongs in Harness Cards. Permission and harm policy
does not.

## Goals

- Make universal safety obvious and true across every model and protocol path.
- Keep token budget decisions understandable, traceable, and testable.
- Make governor and repair decisions visible as structured events.
- Provide a clean foundation for provider-supplied behavior cards without
  letting providers define safety policy.

## Boundary

The Master Harness owns:

- token budget policy and budget zones
- context headroom and output reserve accounting
- dangerous shell blocking
- path sandboxing and obvious system-path blocks
- write-capable tool policy
- stale-write and unsafe plan-write protection once file-state telemetry is
  attached
- trace and scorecard event contracts
- systemic repair rules that are safe across all models

Harness Cards own:

- model matching
- tool schema tolerance
- argument aliases commonly produced by a model family
- malformed JSON/tool-call repair tolerance
- repeated-tool and loop-risk tendencies
- model sampling defaults
- optional plugin hooks for model-specific behavior

## Token Budget Contract

Every request should be able to answer:

- What was the estimated input token count?
- What was the model ceiling?
- What output reserve was held back?
- Which budget zone was selected?
- Was compaction applied?
- How many tokens were recovered?
- How much headroom remained?

Budget zones:

- `green`: under soft limit
- `soft`: safe to run, but compaction or reduction may help
- `heavy`: high pressure, avoid needless context growth
- `emergency`: near hard limit, compact aggressively or shorten
- `reject`: above hard policy limit

Tracing must include budget policy id, zone, limits, headroom, and matched
budget rules.

## Universal Safety Contract

Safety rules are evaluated after safe schema repair and before tool execution.
Schema repair may normalize a model's malformed tool arguments, but it must not
make an unsafe command executable. If repair reveals an unsafe command, the
Master Harness blocks it.

Examples of universal blocks:

- `rm -rf`
- `git clean -f`
- filesystem formatting commands
- shutdown or reboot commands
- `curl | bash`
- fork bomb patterns

The block event must state:

- original tool name
- repaired tool input when repair happened
- matched safety rule
- human-readable reason
- whether retrying is allowed

## Trace Contract

The canonical event kind is `upper_harness_decision_v1`.

It should contain:

- `schema_version`
- `master_policy_id`
- `master_policy_mode`
- `harness_card_id`
- `model_id`
- `provider`
- `action`: `allow`, `repair`, `nudge`, or `block`
- `events[]`: ordered decision events
- `trace.systemic_rules[]`
- `trace.model_rules[]`
- `trace.plugin_rules[]`
- optional `budget`
- optional `safety`
- optional `repaired_tool_call`

Admin and scorecards should use this event instead of reconstructing governor
intent from loosely related fields.

## Implementation Status

The first implementation lives in `packages/synesis-upper-harness`.

It currently provides:

- `MasterHarnessPolicyV1`
- `HarnessCardV1`
- `HarnessPlugin`
- `UpperHarnessEngine`
- built-in cards for generic OpenAI-compatible, Qwen, Kimi, MiniMax, Claude,
  and DeepSeek
- universal shell safety and token budget evaluation
- universal path-prefix and parent-traversal safety

Runtime integration now runs through `base/yarn-ts/src/upper-harness/bridge.ts`.
The OpenAI-compatible and Claude message paths build one harness context per
request, apply card repair and universal safety to every outbound client tool
call, and emit `upper_harness_decision_v1` session events for budget decisions
and non-allow tool decisions. The ACP bridge applies the same universal safety
gate before local filesystem or terminal execution.

Next migration step: retire duplicated adapter-level argument alias maps after
parity is proven, then attach file-state telemetry directly to the Master
Harness so stale-write and plan-stub blocking are implemented there instead of
only in the legacy `governToolCall` layer.

Phase 2 should attach file-state telemetry so stale writes and plan-stub writes
can be blocked by fact, not guesswork. Until then, those rules stay in the
contract and docs rather than pretending a heuristic is authoritative.
