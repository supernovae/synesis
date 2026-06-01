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

**Model reasoning (thinking):** For tiers that support it, clients can send **`enable_thinking`** (and Anthropic `thinking` on `/v1/messages`). Yarn streams reasoning separately from the final answer: on **`/v1/messages`**, as SSE `thinking` / `thinking_delta` blocks; on **`/v1/chat/completions`**, as OpenAI-style **`reasoning_content`** on stream chunks and optional **`message.reasoning_content`** on non-stream completions. The ACP stdio bridge (`synesis-yarn-acp`) uses non-stream OpenAI only; it surfaces returned **`reasoning_content`** in the transcript when enabled — see [ACP_SYNESIS.md](ACP_SYNESIS.md).

### Chat frontend (planner)

- OpenAI-compatible: `POST /v1/chat/completions`
- Also available: `GET /v1/models`, `GET /health`, `GET /metrics`

## Auth model

- **Coder frontend**: PAT with `coder` scope, or OIDC bearer tokens issued by realm `synesis` to client `synesis-harness` when Yarn is configured with `SYNESIS_OIDC_ISSUER_URL`.
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
- [Pi harness with Synesis Coder](../coder/PI_HARNESS.md)
- [Agent Client Protocol (ACP) with Synesis](ACP_SYNESIS.md) — stdio bridge for **Zed**, **JetBrains**, **OpenCode**, **Neovim** (see linked pages)
- [HTTPS-first clients (no ACP)](ACP_HTTP_CLIENTS.md) — Cursor, VS Code agents, Roo, etc.
- [Structured clarification metadata](SYNESIS_CLARIFICATION.md)
- [Chat OpenAI compatibility (planner-ts)](../chat/PLANNER_OPENAI_COMPATIBILITY.md)
- [Yarn runtime details](../YARN_RUNTIME.md)
