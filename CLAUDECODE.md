# Connecting Claude Code to Synesis Yarn

This guide explains how to configure Claude Code to use Synesis Yarn as its
backend model provider.

## Prerequisites

- Synesis Yarn deployed and accessible (e.g. `https://yarn.synesis.example.com`)
- A Synesis PAT (Personal Access Token) with `coder` scope, generated from
  Admin > Security > PATs

## Quick Start

Set the following environment variables before launching Claude Code:

```bash
# Point Claude Code at your Synesis Yarn instance (base URL only; no /v1 suffix)
export ANTHROPIC_BASE_URL="https://yarn.synesis.example.com"

# Use your Synesis PAT as the auth token
export ANTHROPIC_AUTH_TOKEN="your-synesis-pat-here"

# Launch Claude Code — it will use the built-in model picker
claude
```

## Model Tiers

Yarn exposes three model tiers that map directly to Claude's model classes:

| Tier | Model ID | Claude Mapping | Description |
|------|----------|----------------|-------------|
| **Pulse** | `synesis-pulse` | Haiku class | Fast coder — lightweight completions, refactors, tab-complete |
| **Core** | `synesis-core` | Sonnet class | Balanced — multi-step agentic tasks, default for IDE sessions |
| **Horizon** | `synesis-horizon` | Opus class | Deep reasoning — architecture decisions, complex debugging |

### How Claude Code Model Selection Works

When Claude Code sends a model ID like `claude-sonnet-4-6`, the Yarn gateway
automatically maps it to the appropriate tier by matching the Claude model
family:

| Claude model family | Maps to |
|---------------------|---------|
| `haiku` | synesis-pulse |
| `sonnet` | synesis-core |
| `opus` | synesis-horizon |

You can also register a custom model option to appear in Claude Code's `/model` picker:

```bash
export ANTHROPIC_CUSTOM_MODEL_OPTION="synesis-core"
export ANTHROPIC_CUSTOM_MODEL_OPTION_NAME="Synesis Core"
export ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION="Synesis balanced coder tier"
```

### Configuring Tier Backends

Tier configurations are managed in the **Admin panel** under Models > Registry
(roles `coder-pulse`, `coder-core`, `coder-horizon`). Changes are picked up by
Yarn automatically within 60 seconds.

For local development or when the admin API is unreachable, tiers fall back to
environment variables on the Yarn deployment:

```bash
SYNESIS_YARN_PULSE_MODEL="Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8"
SYNESIS_YARN_CORE_MODEL="Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo"
SYNESIS_YARN_HORIZON_MODEL="deepseek-ai/DeepSeek-R1-0528"
SYNESIS_YARN_DEFAULT_TIER="synesis-core"
```

## Authentication

Synesis Yarn accepts bearer tokens in the `Authorization` header. Set
`ANTHROPIC_AUTH_TOKEN` to your PAT value — Claude Code will send it as
`Authorization: Bearer <token>`.

Alternatively, set `ANTHROPIC_API_KEY` and Yarn will accept it via the
`X-Api-Key` header.

## MCP Tool Search

When `ANTHROPIC_BASE_URL` points to a non-first-party host (like Synesis),
Claude Code disables MCP tool search by default because most proxies do not
forward `tool_reference` blocks.

If you want tool search enabled, set on the client:

```bash
export ENABLE_TOOL_SEARCH=true
```

And configure the Yarn gateway to pass through tool search fields:

```bash
# On the Yarn deployment
export SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE=passthrough
```

If you leave the default (`disable`), tool search is gracefully disabled and
all MCP tools are loaded eagerly.

## Verifying the Connection

After launching Claude Code with the above configuration:

1. Run `/status` to confirm the model and API endpoint
2. Try a simple prompt to verify end-to-end connectivity
3. Check Yarn logs for `claude_messages_inbound` entries with `tier` field

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| "Missing required header: anthropic-version" | Client not sending the header | Ensure you're using Claude Code (not a raw curl) or add `anthropic-version: 2023-06-01` |
| 401 Unauthorized | Bad or missing PAT | Regenerate PAT with `coder` scope in Admin |
| "Unknown model" error | Model ID not matching any tier | Use a Claude model family name (haiku/sonnet/opus) or an explicit tier ID (synesis-pulse/core/horizon) |
| Tool search not working | Disabled by default on non-first-party hosts | Set `ENABLE_TOOL_SEARCH=true` on client and `SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE=passthrough` on gateway |

## Prompt Caching and Premier Provider Behavior

Yarn-ts optimizes for prompt caching by default. Two features keep the
cacheable prefix stable across requests so upstream providers can reuse it:

**Sorted tool schemas.** All tool definitions are serialized with
recursively sorted JSON keys (`SYNESIS_YARN_SORTED_TOOLS_ENABLED=true` by
default). Two logically identical tool lists will always produce the same byte
sequence, preventing cache misses from key-order drift.

**Jitter buffer.** Dynamic content (timestamps, cwd paths, session IDs, branch
names) is extracted from system messages and appended to the final user message
inside an `<ENVIRONMENT_CONTEXT>` wrapper. The large static system prefix +
tools remain byte-stable across turns. Enable/disable with
`SYNESIS_YARN_JITTER_BUFFER_ENABLED` (default: true).

When the upstream tier is an Anthropic Messages–compatible endpoint, Yarn will
apply `cache_control: { type: "ephemeral" }` after the static prefix + tools
and include the `prompt-caching-2024-07-31` beta header. This requires a native
Anthropic outbound path (planned); OpenAI-compatible tiers benefit only from
the structural stability provided by sorted tools and jitter buffer.

## Multi-Client Support

Yarn serves any OpenAI- or Anthropic Messages–compatible client. Send
`x-synesis-client` and optionally `x-synesis-mode` headers for client-specific
adapter behavior:

| Header | Values | Effect |
|--------|--------|--------|
| `x-synesis-client` | `claude-code`, `cursor`, `roo`, `windsurf`, `continue`, `cline`, `codex-cli`, `vscode-copilot`, `junie`, or custom | Selects adapter pack (interaction mode, workflow hints) |
| `x-synesis-mode` | `ide`, `cli`, `background`, `mcp_native` | Overrides auto-detected interaction mode |

Adapter packs are listed at `GET /v1/adapter-packs`. They influence system
prompt phrasing and policy behavior, not protocol shape — all clients speak
either OpenAI chat completions or Anthropic Messages.

## Session Scoping

Yarn tracks per-conversation sessions to isolate state, usage, and cost across
clients. Each session is keyed as `synesis:{userId}:{clientKind}:{conversationId}`.

For Claude Code clients, Yarn resolves the conversation ID from these sources
(first non-empty wins):

1. `body.metadata.synesis_conversation_id`
2. `body.metadata.conversation_id`
3. `body.metadata.session_id`
4. `x-synesis-conversation-id` header

If none are provided, conversations for the same user and client share a single
session. To get per-conversation isolation, pass a stable conversation identifier
in your request metadata:

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 8192,
  "metadata": { "synesis_conversation_id": "my-project-abc123" },
  "messages": [...]
}
```

Enable `SYNESIS_YARN_DEBUG_PROTOCOL=true` on the Yarn deployment to log which
source resolved the conversation ID for each request.

## Debugging

Set `SYNESIS_YARN_DEBUG_PROTOCOL=true` to emit structured protocol logs for
every request (model, message/tool counts, presence of system/tools/thinking,
client headers). Logs never include prompt content or auth tokens.

Request IDs are propagated from the client `x-request-id` or
`anthropic-request-id` header (or generated as `req-<uuid>`). They appear in
all log entries and trace records.

The `GET /v1/diagnostics/recent` endpoint returns the last 20 request
summaries (message counts, latency, policy decisions, token usage) for
operational debugging.

## Reference

- [Claude Code Environment Variables](https://code.claude.com/docs/en/env-vars)
- [Claude Code Model Configuration](https://docs.anthropic.com/en/docs/claude-code/model-config)
- [Enterprise Deployment: Proxies and Gateways](https://docs.anthropic.com/en/docs/claude-code/bedrock-vertex-proxies)
- [Anthropic Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [Synesis Design Note](docs/claude_code_compat.md)
