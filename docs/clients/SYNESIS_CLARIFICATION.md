# Structured clarification (Yarn coder API)

Clients can send a **machine-readable clarification round** so UIs can render forms, wizards, or per-question flows without scraping assistant Markdown.

## Request

### Claude Messages (`POST /v1/messages`)

Put the payload on **`metadata.synesis_clarification_round`** (object or JSON string):

```json
{
  "round_id": "r1",
  "questions": [
    { "id": "auth", "prompt": "Which AWS auth flow?", "required": true },
    { "id": "region", "prompt": "Default region?" }
  ]
}
```

### OpenAI chat completions (`POST /v1/chat/completions`)

Send the same object on **`metadata.synesis_clarification_round`** (top-level field on the JSON body; passthrough).

## Orchestrator phase (tier routing)

Optional header:

`x-synesis-orchestrator-phase: planning | implementation | validation | explore | auto`

- **`auto`** or omitted: phase is inferred from the working frame and user text (default).
- **`planning`**: forces planning phase for tier selection (typically **`synesis-horizon`** when `SYNESIS_YARN_PLANNING_USE_HORIZON` is true).

## Response

When a validated round is stored for the session, Yarn may set:

`X-Synesis-Clarification-Round: <json>`

(Same shape as the request.) Present on successful chat completion and SSE responses when applicable.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `SYNESIS_YARN_PLANNING_USE_HORIZON` | `true` | Use Horizon tier for planning-phase sessions (legacy inference path). Set `false` to use keyword-only horizon escalation for planning. |
