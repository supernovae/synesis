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
# Point Claude Code at your Synesis Yarn instance
export ANTHROPIC_BASE_URL="https://yarn.synesis.example.com/v1"

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

## Reference

- [Claude Code Environment Variables](https://code.claude.com/docs/en/env-vars)
- [Claude Code Model Configuration](https://docs.anthropic.com/en/docs/claude-code/model-config)
- [Enterprise Deployment: Proxies and Gateways](https://docs.anthropic.com/en/docs/claude-code/bedrock-vertex-proxies)
- [Synesis Design Note](docs/claude_code_compat.md)
