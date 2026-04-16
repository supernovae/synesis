# Governor Pause Envelope

The execution governor can hard-pause a session when repeated recovery rewrites are ignored.  
To keep this behavior portable across IDEs and agent clients, Yarn now emits a structured, transport-agnostic pause contract named `synesis_governor_pause`.

This contract is intended for:

- IDE extensions (Cursor, VS Code, JetBrains plugins)
- CLI clients
- API gateways/proxies
- Automation harnesses

## Why this exists

Plain text hard-stop guidance is useful for humans, but clients need machine-readable fields to:

- render consistent next-action choices
- disable blind auto-retry loops
- route to explicit user confirmation
- preserve behavior across OpenAI-compatible and Claude-compatible transports

## Envelope schema

`synesis_governor_pause` contains:

```json
{
  "status": "paused",
  "pause_reason": "verification_intent_without_action",
  "matched_rules": ["verification_intent_without_action", "no_progress_loop"],
  "required_user_action": true,
  "recovery_attempts_used": 5,
  "hard_stop_threshold": 5,
  "next_automatic_step_allowed": false,
  "next_actions": [
    {
      "id": "run_targeted_test",
      "label": "Run one targeted test",
      "description": "Run one narrow test/build command only, then use the result.",
      "requires_user_input": true,
      "can_auto_execute": true,
      "expected_arguments": ["command"]
    },
    {
      "id": "apply_one_edit",
      "label": "Apply one focused edit",
      "description": "Make one concrete code edit before any additional verification.",
      "requires_user_input": true,
      "can_auto_execute": true,
      "expected_arguments": ["file_path", "change_summary"]
    },
    {
      "id": "summarize_and_stop",
      "label": "Summarize and stop",
      "description": "Stop execution and summarize what is missing or completed.",
      "requires_user_input": false,
      "can_auto_execute": true
    }
  ],
  "default_recommended_action": "apply_one_edit",
  "resume_hint": "Reply with action id and optional arguments, for example: run_targeted_test command=\"go test ./cmd/synesis -run TestRunCompletion -v\""
}
```

## Transport placement

Yarn includes `synesis_governor_pause` in both protocol families.

- **OpenAI-compatible**
  - non-streaming: top-level response field
  - streaming: included in emitted chunk payloads
- **Claude-compatible**
  - non-streaming: top-level response field
  - streaming: emitted as a dedicated SSE event: `synesis_governor_pause`

The assistant text still contains a human-readable hard-stop summary for clients that do not parse structured fields.

## Client behavior contract

When `status=paused`:

1. Stop autonomous continuation.
2. Surface `next_actions` to the user.
3. Prefer `default_recommended_action`.
4. Resume only after explicit selection or explicit user freeform instruction.
5. Preserve envelope fields in logs for regression analysis.

## Minimal client pseudo-flow

```text
if response.synesis_governor_pause?.status == "paused":
  renderChoiceUI(next_actions, default_recommended_action)
  disableAutoRetry()
  waitForUserSelection()
  submitSelectionAsNextUserTurn()
```

## Producer locations

- Envelope shape/builders: `base/yarn-ts/src/governance/execution-governor.ts`
  - `buildExecutionGovernorPauseEnvelope(...)`
- Hard-stop emission wiring: `base/yarn-ts/src/index.ts`
  - OpenAI soft-fail sender
  - Claude soft-fail sender

## Related docs

- [GOVERNOR_HARNESS.md](./GOVERNOR_HARNESS.md)
- [EVAL_GYM.md](./EVAL_GYM.md)
- [observability-verification-and-evals.md](./observability-verification-and-evals.md)
