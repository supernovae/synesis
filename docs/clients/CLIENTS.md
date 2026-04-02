# Synesis Client Configuration

This guide describes how to connect client applications to Synesis frontends
using user-facing terminology.

## Frontend names (recommended)

- **Coder frontend**: `yarn-ts` for coding/agent IDE clients.
- **Chat frontend**: planner OpenAI-compatible chat surface for conversational UIs.

Use these terms in user docs and product-facing setup instructions.

## Which frontend to use

- Use **coder frontend** for:
  - Claude Code
  - Cursor
  - Codex CLI
  - Cline / Continue / Windsurf / other IDE agents
- Use **chat frontend** for:
  - Open WebUI
  - Custom app chat UIs
  - Any OpenAI chat client focused on conversational assistant UX

## Endpoint mapping

### Coder frontend (`yarn-ts`)

- Anthropic-compatible: `POST /v1/messages`
- OpenAI-compatible: `POST /v1/chat/completions`
- Also available: `GET /v1/models`, `GET /health`, `GET /metrics`

### Chat frontend (planner)

- OpenAI-compatible: `POST /v1/chat/completions`
- Also available: `GET /v1/models`, `GET /health`, `GET /metrics`

## Auth model

- **Coder frontend**: PAT with `coder` scope (or configured enterprise auth flow).
- **Chat frontend**: planner auth policy (Bearer mode or deployment policy defaults).

## Naming guidance for docs/UI

- Prefer:
  - "Connect your IDE to the **coder frontend**"
  - "Connect your chat app to the **chat frontend**"
- Avoid backend-internal labels in user docs:
  - "planner" (unless writing internal architecture docs)
  - "yarn-ts" (unless writing implementation docs)

## Client-specific docs

- [Session execution context (workspace root, shell cwd, optional metadata)](SESSION_EXECUTION_CONTEXT.md)
- [Claude Code on coder frontend](CLAUDECODE.md)
- [Planner OpenAI compatibility](../PLANNER_OPENAI_COMPATIBILITY.md)
- [Yarn runtime details](../YARN_RUNTIME.md)
