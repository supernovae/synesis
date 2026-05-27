# Governor Behavior Validation

Synesis should not rely on live trial-and-error to discover whether the execution governor is helping or blocking coding momentum. Governor quality is validated in three lanes:

1. **Offline replay fixtures** in `tests/fixtures/governor-replay`.
2. **Eval-gym model scenarios** in `src/eval/scenarios`.
3. **Reviewed trace harvests** promoted from production/session telemetry.

The offline lane is the release gate for deterministic behavior. Eval-gym is the model-in-loop canary. Trace harvests are the source of new cases when a human finds a surprising stop, loop, or recovery.

## Fixture Taxonomy

Every governor fixture should be tagged as one of:

- `allow`: forward momentum must not pause.
- `pause`: a real loop or unsafe completion claim must pause.
- `recovery`: the flow starts from dirty/compacted/partial state.
- `client`: include `opencode`, `claude-code`, `codex`, or another client tag when the shape is client-specific.
- `language`: include `python`, `go`, `typescript`, etc. when the test models a language workflow.

The minimum high-value corpus is:

- Fresh build: discover -> create/edit -> test -> finalize.
- Dirty workspace: distinct discovery -> task update -> first verification.
- Resume: continuity state -> one targeted read -> edit/test.
- Missing tests: `[no test files]` -> create tests, not retest.
- Compile failure: first failure allowed, repeated same failure pauses.
- Stale read: same unchanged file reread pauses.
- Completion claim: repeated verification after “done” pauses.

## Fixture Schema

Replay fixtures are JSON files consumed by `governor-replay-fixtures.test.ts`.

```json
{
  "name": "short-stable-id",
  "description": "What behavior this locks down.",
  "tags": ["allow", "python", "opencode"],
  "source": "manual",
  "options": {
    "modelAdapterFamily": "minimax",
    "chatState": {
      "activeObjective": "Build the app",
      "pendingUserDirective": "Build the app",
      "completionStatus": "blocked",
      "lastVerificationOutcome": "fail"
    }
  },
  "messages": [],
  "expected": {
    "pause": false,
    "phase": "verify",
    "matchedRulesIncludes": [],
    "matchedRulesExcludes": ["verification_churn_no_edit"],
    "forbiddenRules": ["no_progress_loop"]
  }
}
```

Use `matchedRulesIncludes` for rules that are essential to the behavior. Use `forbiddenRules` for false-positive prevention. Avoid over-specifying `reason` unless rule priority is part of the contract.

## Codex-Assisted Scenario Authoring

Codex 5.3 can draft candidate fixtures, but it must not decide expected behavior alone. Use this prompt shape:

```text
Given the Synesis governor fixture schema, draft 5 replay fixtures for <flow>.
For each fixture include:
- intent and tags
- transcript messages/tool results
- expected pause behavior
- forbidden false-positive rules
Do not invent new governor rules. Prefer existing rules from execution-governor.ts.
Mark source as "model_draft".
```

Review each draft manually before promotion:

- Does it model a real software flow?
- Is the expected behavior product-correct?
- Is it deterministic without a live model?
- Does it assert behavior, not incidental implementation details?

Once accepted, change `source` from `model_draft` to `manual` or `trace`.

## Eval-Gym Lane

Eval-gym scenarios validate model behavior through `/v1/chat/completions` with simulated tools. They are slower and less deterministic than replay fixtures, so use them for canaries:

- `governor_regression`: loop prevention and recovery.
- `power_user_canary`: long-session developer experience.
- `e2e_build`: fresh app build and verification.

Run examples:

```bash
npm run cli --prefix base/yarn-ts -- eval-gym --category governor_regression
npm run cli --prefix base/yarn-ts -- eval-gym --scenario dirty-workspace-recovery-momentum
```

Known next improvement: make simulated tools stateful by call index/signature so scenarios can model path correction, duplicate workspaces, and “first failure vs repeated failure” without relying only on a single result per tool name.

Stateful simulated tools are supported in three forms:

```ts
simulatedToolResults: {
  Bash: ["first run failed", "second run passed"],
  Read: {
    bySignature: {
      "path:taskpulse/app/main.py": "from fastapi import FastAPI",
      "path:app.js": "File not found: /workspace/app.js"
    },
    default: "generic read result"
  },
  Write: "File written successfully"
}
```

Use arrays for call-order behavior. Use `bySignature` for command/path/pattern-specific behavior. Useful signatures include `command:<shell command>`, `path:<path>`, `pattern:<glob/search>`, and `<tool-name>:<normalized raw arguments>`.

## Eval Client Lab Lane

Eval Client Lab is the API-level complement to Harness Lab. It reuses eval-gym scenarios but sweeps them across client profiles such as `raw-openai`, `opencode`, `claude-code`, `codex-cli`, and `cursor`.

Use this when you want to answer:

- Does the same governor scenario behave differently for OpenCode-like vs Claude-Code-like session identity?
- Does raw OpenAI-compatible pass-through stay free of developer-harness policy assumptions?
- Are profile headers and session client ids visible in telemetry?
- Which client profile has more recovery loops, hard stops, or lower scenario scores?

Run examples:

```bash
SYNESIS_EVAL_TARGET_URL=http://localhost:8000 \
SYNESIS_EVAL_TARGET_KEY=$SYNESIS_TEST_PAT_TOKEN \
npm run eval:lab --prefix base/yarn-ts -- \
  --profiles raw-openai,opencode,claude-code,codex-cli \
  --category governor_regression \
  --rounds 2 \
  --out /tmp/eval-client-lab.json \
  --markdown /tmp/eval-client-lab.md \
  --allow-failures
```

Use Harness Lab for real lower-harness subprocess behavior. Use Eval Client Lab for cheaper, faster API-level sweeps over the deterministic eval-gym scenario corpus.

## Promotion Rule

When a live run surprises us:

1. Capture the minimal transcript around the governor decision.
2. Remove secrets and irrelevant long output.
3. Convert it into an offline replay fixture.
4. Add one opposite fixture if possible, so the fix cannot overcorrect.
5. Only then adjust governor logic.

This keeps the governor from accumulating one-off exceptions without a behavior contract.

## Harness Lab Lane

Replay fixtures and eval-gym do not fully exercise lower developer harnesses. OpenCode, Claude Code, Codex CLI, Continue, and similar tools add their own cwd handling, task lists, resume behavior, tool schemas, and recovery prompts. Use Harness Lab when the question is “what happened in the actual harness process?”

Harness Lab runs real client commands in disposable workspaces and produces:

- Raw stdout/stderr and exit status.
- Optional Yarn admin session events when `SYNESIS_EVAL_ADMIN_URL` and `SYNESIS_EVAL_ADMIN_TOKEN` are provided.
- Risk signals for path confusion, invalid tool arguments, unsafe shell blocks, discovery churn, verification churn, task resets, and governor pauses.
- A candidate fixture draft that can be manually promoted into `tests/fixtures/governor-replay`.
- A compact Markdown report for human review.

Example spec:

```json
{
  "schemaVersion": "harness_lab_v1",
  "name": "TaskPulse OpenCode MiniMax recovery",
  "client": {
    "id": "opencode",
    "command": "opencode",
    "args": ["run", "--model", "core", "--prompt-file", "{promptFile}"],
    "env": {
      "OPENAI_BASE_URL": "http://localhost:8000/v1",
      "OPENAI_API_KEY": "{sessionKey}"
    }
  },
  "defaults": {
    "timeoutMs": 600000,
    "cleanup": true
  },
  "cases": [
    {
      "id": "fresh-taskpulse-build",
      "sessionKey": "lab-fresh-taskpulse",
      "tags": ["opencode", "minimax", "python", "fresh_build"],
      "prompt": "Build the complete TaskPulse application...",
      "expected": {
        "allowGovernorPause": false,
        "forbiddenSignals": ["path_confusion", "invalid_tool_arguments", "task_reset"]
      }
    }
  ]
}
```

Run it:

```bash
npm run harness:lab --prefix base/yarn-ts -- \
  --spec /tmp/taskpulse-harness-lab.json \
  --out /tmp/taskpulse-harness-lab-results.json \
  --markdown /tmp/taskpulse-harness-lab.md \
  --allow-failures
```

Use `--dry-run` to verify placeholder expansion without launching the lower harness. Placeholders are expanded in args/env/cwd:

- `{workspace}`: disposable workspace directory.
- `{promptFile}`: prompt written under `.synesis-harness-lab/prompt.txt`.
- `{prompt}`: raw prompt text.
- `{caseId}`: case id.
- `{model}`: optional case model.
- `{sessionKey}`: optional case session key.

Harness Lab intentionally launches commands with `shell: false`. If a client truly needs shell behavior, make that explicit in the spec by using `bash` or `zsh` as the command and a narrow argument list. Do not use Harness Lab specs for destructive cleanup of user workspaces; let the runner create and clean its own temporary workspaces.

The repository includes a first durable-work-packet lab spec for models with
weak long-tail retention or path/task-state drift:

```bash
npm run harness:lab --prefix base/yarn-ts -- \
  --spec tests/fixtures/harness-lab/deepseek-xiaomi-work-packet.json \
  --dry-run
```

Run it without `--dry-run` after exporting the lower-harness OpenAI-compatible
environment variables that your client expects, such as `OPENAI_BASE_URL` and
`OPENAI_API_KEY`. The spec currently targets DeepSeek/Xiaomi-style fragile
long-context scenarios: fresh empty workspace creation, duplicated path
recovery, todo-schema recovery, and verification after writes. It is meant to
catch regressions where the governor treats forward discovery as churn or where
the model resets task state after a recoverable tool/prompt failure.

## Model-Assisted Analysis Loop

The recommended workflow is:

1. Main agent designs the lab case and validates the product-correct expected behavior.
2. A cheaper model such as GPT-5.3 Codex Spark drafts additional case variants, tags, and likely failure hypotheses.
3. Harness Lab runs those cases against real lower harnesses and writes machine-readable risk reports.
4. A stronger model reviews the report, clusters repeated risks, and proposes the smallest replay fixtures and governor changes.
5. Humans promote only reviewed fixtures into the deterministic suite.

This gives us a repeatable way to use model credits for breadth without letting a model directly tune production governor behavior from vibes. The durable contract remains the replay fixture, eval scenario, or regression budget.
