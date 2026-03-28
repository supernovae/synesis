# Claude Code Compatibility — Design Note

## Overview

Synesis Yarn now supports Claude Code clients natively via an Anthropic Messages
API surface (`POST /v1/messages`). The design preserves Claude semantics as long
as possible and only translates to OpenAI at the downstream provider boundary.

## Motivation

Claude Code is Anthropic's terminal-based AI agent. When configured with
`ANTHROPIC_BASE_URL`, it sends requests in the Anthropic Messages wire format
rather than OpenAI Chat Completions. Supporting this format directly lets
organisations use Claude Code against Synesis-managed models without requiring
the client to run a local shim.

## Detection Strategy

Requests are classified by an ordered multi-signal pipeline. The first matching
signal wins:

| Priority | Signal | What it checks |
|----------|--------|----------------|
| 1 | Explicit config flag | `SYNESIS_YARN_CLAUDE_COMPAT_ENABLED=true` |
| 2 | `anthropic-version` header | Required by all Anthropic SDK clients ([API Versioning](https://docs.anthropic.com/en/api/versioning)) |
| 3 | Claude Messages request shape | Top-level `max_tokens` + content-block message arrays without OpenAI-specific keys |
| 4 | Claude-style model ID | `claude-*` or any ID in `SYNESIS_YARN_CLAUDE_CUSTOM_MODEL_IDS` / `model_overrides` |
| 5 | `input_schema` tools | Tools using `input_schema` instead of `function.parameters` |

User-Agent is **not** used as a primary signal. It is logged for observability
but does not drive routing.

## Protocol Handling

### Anthropic Messages API (`/v1/messages`)

The endpoint validates:
- `anthropic-version` header (required, must match `20XX-XX-XX` format per
  [API Versioning](https://docs.anthropic.com/en/api/versioning))
- Required body fields: `model`, `max_tokens`, `messages`

Preserved inbound fields:
- `anthropic-beta` header (passed through for beta features like extended
  thinking)
- `tools` with `input_schema` (Anthropic-native schema, not converted until
  provider boundary)
- `tool_choice` with Claude semantics (`auto`, `none`, `any`, `tool`)
- `thinking` configuration
- Content block types: `text`, `tool_use`, `tool_result`, `thinking`,
  `tool_reference`

### Streaming SSE

The streaming response follows the Anthropic SSE event model
([Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)):

1. `event: message_start` — initial message envelope
2. `event: ping` — keep-alive
3. `event: content_block_start` / `content_block_delta` / `content_block_stop` — per block
4. `event: message_delta` — final stop reason and usage
5. `event: message_stop` — end marker

Delta types: `text_delta`, `input_json_delta`, `thinking_delta`, `signature_delta`.

Error events use `event: error` with `{"type": "error", "error": {...}}`.

## Canonical Internal Model

All inbound requests (Claude Messages or OpenAI Chat) are converted to a
canonical internal model before processing. This model preserves Claude
content-block semantics:

```
InboundRequest → CanonicalRequest → [downstream adapter] → Provider
Provider response → CanonicalResponse → [outbound adapter] → Client response
```

Translation to OpenAI's `function.parameters` / `tool_calls` format happens
**only** at the provider boundary in `openai_bridge.py`, not in the canonical
layer.

## Model Routing — Three-Tier System

Yarn routes all model requests through a three-tier abstraction:

| Tier | Client-facing ID | Claude family match | Default backend |
|------|------------------|---------------------|-----------------|
| **Pulse** | `synesis-pulse` | `haiku` | Qwen3-Coder-30B-A3B-Instruct-FP8 |
| **Core** | `synesis-core` | `sonnet` | Qwen3-Coder-480B-A35B-Instruct-Turbo |
| **Horizon** | `synesis-horizon` | `opus` | DeepSeek-R1-0528 |

### Claude Model Resolution

When Claude Code sends a model ID (e.g. `claude-3-5-sonnet-20241022`), the
`TierRegistry.resolve_claude()` method matches the model family substring to
the appropriate tier. The mapping is:

- Any model containing `haiku` -> **synesis-pulse**
- Any model containing `sonnet` -> **synesis-core**
- Any model containing `opus` -> **synesis-horizon**
- Unmatched models -> default tier (synesis-core)

The Claude family map can be overridden via `SYNESIS_YARN_CLAUDE_TIER_MAP`
(JSON) for custom routing.

### Admin as Single Source of Truth

Tier configurations (backend model, endpoint, API key, cost rates) are
managed through the admin panel's Model Registry under roles `coder-pulse`,
`coder-core`, and `coder-horizon`. Yarn polls the admin API every 60 seconds
and atomically swaps its registry when changes are detected.

Environment variables serve as a fallback when the admin API is unreachable
(local development, bootstrap).

### OpenAI Model Endpoint

`GET /v1/models` returns exactly the three tier models, making them visible
to Cursor and other OpenAI-compatible IDE clients.

## MCP Tool Search Policy

When `ANTHROPIC_BASE_URL` points to a non-first-party host, Claude Code
disables tool search by default because most proxies do not forward
`tool_reference` blocks
([MCP: Configure tool search](https://docs.anthropic.com/en/docs/claude-code/mcp#configure-tool-search),
[Tool Search Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)).

The gateway supports two modes via `SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE`:

| Mode | Behavior |
|------|----------|
| `disable` (default) | Strip `defer_loading` and `tool_reference` blocks from outbound payloads. All tools loaded eagerly. Clear diagnostic log emitted. |
| `passthrough` | Preserve all tool-search-related fields. Use when the downstream provider natively supports Anthropic tool search. |

## Agent SDK Parity

The Claude Agent SDK "gives you the same tools, agent loop, and context
management that power Claude Code"
([Agent SDK Overview](https://docs.anthropic.com/en/docs/claude-code/sdk)).
The gateway's Messages API surface is designed to be compatible with both
Claude Code and Agent SDK clients.

## Observability (yarn-ts)

Set `SYNESIS_YARN_DEBUG_PROTOCOL=true` for structured per-request logs.

Log events emitted by yarn-ts:
- `debug_protocol` — per-request one-liner: model, anthropic-version, message/tool
  counts, system/tools/thinking presence, tool-search mode, stream flag
- `Claude stream error` / `OpenAI stream error` — upstream failures with request ID
- `policy_safety_event` — circuit breaker / repeat guard activations
- `tier_registry_refreshed` / `tier_registry_refresh_failed` — admin polling

Request IDs (`x-request-id` or `anthropic-request-id` from client, or generated
`req-<uuid>`) propagate through all log entries, trace records, and the
`GET /v1/diagnostics/recent` ring buffer.

## Configuration Reference

### Tier Configuration (Yarn deployment)

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `SYNESIS_YARN_PULSE_MODEL` | `Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8` | Backend model for Pulse tier |
| `SYNESIS_YARN_PULSE_URL` | `""` | Override base URL for Pulse (falls back to provider default) |
| `SYNESIS_YARN_CORE_MODEL` | `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo` | Backend model for Core tier |
| `SYNESIS_YARN_CORE_URL` | `""` | Override base URL for Core |
| `SYNESIS_YARN_HORIZON_MODEL` | `deepseek-ai/DeepSeek-R1-0528` | Backend model for Horizon tier |
| `SYNESIS_YARN_HORIZON_URL` | `""` | Override base URL for Horizon |
| `SYNESIS_YARN_DEFAULT_TIER` | `synesis-core` | Default tier when model ID is ambiguous |
| `SYNESIS_YARN_CLAUDE_TIER_MAP` | `""` | JSON override for Claude family-to-tier mapping |
| `SYNESIS_YARN_TIER_POLL_INTERVAL` | `60` | Seconds between admin API config polls |

### Claude Compatibility and Premier Caching (yarn-ts)

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `SYNESIS_YARN_CLAUDE_COMPAT_ENABLED` | `false` | Force all `/v1/messages` traffic through Claude path (signal 1) |
| `SYNESIS_YARN_CLAUDE_CUSTOM_MODEL_IDS` | `""` | Comma-separated custom model IDs to accept (signal 4) |
| `SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE` | `disable` | `disable` strips `defer_loading` + `tool_reference`; `passthrough` preserves them |
| `SYNESIS_YARN_SORTED_TOOLS_ENABLED` | `true` | Recursively sort tool schema JSON keys for cache-stable serialization |
| `SYNESIS_YARN_JITTER_BUFFER_ENABLED` | `true` | Move dynamic content (dates, paths, session IDs) from system messages to final user message |
| `SYNESIS_YARN_DEBUG_PROTOCOL` | `false` | Emit structured per-request protocol logs (never includes prompt content) |

## Resolved and Remaining Gaps (yarn-ts)

### Resolved

- **Top-level `system`** field is now parsed and merged as a system message
  (string and content-block array formats supported).
- **`temperature`**, **`stop_sequences`** are forwarded to `generateText` /
  `streamText` upstream calls.
- **Tool-search policy** (`defer_loading`, `tool_reference` stripping) is
  implemented with a `disable` / `passthrough` toggle.
- **Sorted tool schemas** ensure byte-stable serialization across requests.
- **Jitter buffer** separates dynamic system content from the cacheable prefix.
- **Request-ID propagation** via `x-request-id` / `anthropic-request-id`.

### Remaining / Uncertain

1. **Prompt caching** (`cache_control: { type: "ephemeral" }` + `prompt-caching-2024-07-31`
   beta header) requires a native Anthropic outbound path. OpenAI-compatible
   tiers benefit from sorted tools + jitter buffer only.
2. **Extended thinking** (`thinking` config) — forwarded via `providerOptions`
   but downstream support depends on the model provider.
3. **`anthropic-beta` feature flags** — preserved from client but not yet
   merged with proxy-injected beta strings on the outbound path.
4. **Tool search `auto:N` thresholds** — binary policy only (passthrough or
   disable); per-threshold logic is client-side.
5. **Image content blocks** — parsed but not validated end-to-end.
6. **Bedrock/Vertex model IDs** — accepted but no ARN/version validation.

## Source References

- [Claude Code Model Configuration](https://docs.anthropic.com/en/docs/claude-code/model-config)
- [Claude Code Environment Variables](https://code.claude.com/docs/en/env-vars)
- [Enterprise Deployment / LLM Gateway](https://docs.anthropic.com/en/docs/claude-code/bedrock-vertex-proxies)
- [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Tool Search Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [Agent SDK Overview](https://docs.anthropic.com/en/docs/claude-code/sdk)
- [API Versioning](https://docs.anthropic.com/en/api/versioning)
- [Using the Messages API](https://platform.claude.com/docs/en/build-with-claude/working-with-messages)
- [Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [How to Implement Tool Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use)
- [Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)

## Multi-Client Adapter Packs

Yarn-ts supports any OpenAI- or Anthropic Messages–compatible client. Clients
identify themselves via `x-synesis-client` header; the adapter pack system
adjusts system-prompt phrasing and policy hints accordingly.

Known clients: `claude-code`, `cursor`, `roo`, `windsurf`, `continue`, `cline`,
`codex-cli`, `vscode-copilot`, `junie`. Custom names are accepted and default
to `ide` mode.

Interaction modes (`x-synesis-mode` override):
- `ide` — default for IDE clients; full context injection
- `cli` — concise validation-oriented responses
- `background` — planning workflow, artifact handles preferred
- `mcp_native` — MCP-first clients

The adapter catalog is available at `GET /v1/adapter-packs`.
