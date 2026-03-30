# Claude Code with Synesis Coder

This guide explains how to connect Claude Code to the Synesis **coder frontend**
(`yarn-ts`) and what to expect from the protocol.

## Terminology

- **Coder frontend**: `yarn-ts` for IDE/agent workflows (Claude Code, Cursor, Codex CLI, etc.).
- **Chat frontend**: Planner OpenAI surface for conversational apps and UIs (for example Open WebUI or custom chat apps).

## Prerequisites

- Synesis coder frontend (`yarn-ts`) deployed and reachable, for example:
  `https://coder.synesis.example.com`
- A Synesis PAT with `coder` scope from Admin > Security > PATs

## Quick start

```bash
# Base URL should point to your Yarn TS host (no /v1 suffix)
export ANTHROPIC_BASE_URL="https://coder.synesis.example.com"

# Synesis PAT with coder scope
export ANTHROPIC_AUTH_TOKEN="your-synesis-pat"

# Optional, but useful for model picker clarity
export ANTHROPIC_CUSTOM_MODEL_OPTION="synesis-core"
export ANTHROPIC_CUSTOM_MODEL_OPTION_NAME="Synesis Core"
export ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION="Synesis balanced coder tier"

claude
```

## Protocol and endpoints

Claude Code speaks Anthropic Messages format and should target:

- `POST /v1/messages` on `yarn-ts` (coder frontend)

`yarn-ts` also exposes OpenAI-compatible endpoints (`/v1/chat/completions`) for
other coder clients, but Claude Code should stay on `/v1/messages`.

## Model tier mapping

Yarn exposes three client-facing coder tiers:

- `synesis-pulse` (haiku-class)
- `synesis-core` (sonnet-class, default)
- `synesis-horizon` (opus-class)

Claude family matching:

- `haiku` -> `synesis-pulse`
- `sonnet` -> `synesis-core`
- `opus` -> `synesis-horizon`

## Key yarn-ts settings

These are the most relevant runtime controls for Claude Code behavior:

- `SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE` (`disable` or `passthrough`)
- `SYNESIS_YARN_SORTED_TOOLS_ENABLED` (default `true`)
- `SYNESIS_YARN_JITTER_BUFFER_ENABLED` (default `true`)
- `SYNESIS_YARN_DEBUG_PROTOCOL` (default `false`)
- `SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT`
- `SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT`
- `SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT`
- `SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED`

The last four control loop safety. Current default behavior is soft-fail first
for recoverable loops, with hard-stop only for genuine runaway patterns.

## Conversation scoping

For Claude requests, conversation identity resolves in this order:

1. `metadata.synesis_conversation_id`
2. `metadata.conversation_id`
3. `metadata.session_id`
4. `x-synesis-conversation-id` header

If none are provided, requests share a user+client scoped session.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing required header: anthropic-version` | Non-Claude client shape or raw call missing header | Use Claude Code client or include required Anthropic headers |
| `401 Unauthorized` | Missing/invalid PAT | Regenerate PAT with `coder` scope |
| Tool search not working | Default `disable` mode | Set `ENABLE_TOOL_SEARCH=true` client-side and `SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE=passthrough` server-side |
| Loop message asking for guidance | Safe-fail loop guard triggered | Provide one corrective user instruction (tool install, alternate command, narrower repair plan) |

## Related docs

- [Client setup overview](CLIENTS.md)
- [Claude compatibility design note](../claude_code_compat.md)
- [Yarn TS runtime](../YARN_RUNTIME.md)
