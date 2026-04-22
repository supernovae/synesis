# Agent Client Protocol (ACP) with Synesis

This document describes the **Synesis ACP bridge** (`synesis-yarn-acp`): a small process that speaks the [Agent Client Protocol](https://agentclientprotocol.com/) over **stdio** (JSON-RPC) and forwards work to the **Synesis coder frontend** (`yarn-ts`) over **HTTPS** using the **OpenAI-compatible** API (`POST /v1/chat/completions`) — the same core surface as other IDE integrations. The Anthropic Messages route (`POST /v1/messages`) remains for **Claude Code** and other Anthropic-shaped clients only.

## When to use ACP vs HTTPS

| Integration | Use |
|-------------|-----|
| **Claude Code, Cursor, Roo, VS Code** extensions that use a **base URL + API key** | Connect directly to `https://<coder-host>` (see [CLIENTS.md](CLIENTS.md), [CLAUDECODE.md](CLAUDECODE.md)). |
| **Editors** that spawn an **external agent** over stdio (Zed, JetBrains with ACP, Neovim plugins, OpenCode `acp`) | Run the **`synesis-yarn-acp`** binary and point the editor at it. |

## Prerequisites

- Yarn (`yarn-ts`) deployed and reachable over HTTPS (for example `https://coder.example.com`).
- A Synesis PAT with **coder** scope (same as HTTP clients).
- Node.js **24+** (or the runtime you use to run the repo).

## Build the binary

From the repo root:

```bash
cd base/yarn-ts && npm install && npm run build
```

The entry is emitted to `base/yarn-ts/dist/acp/synesis-yarn-acp.js`.

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `SYNESIS_YARN_URL` | Yes | Base URL only (no `/v1` suffix), e.g. `https://coder.example.com` |
| `SYNESIS_YARN_TOKEN` | Yes | Synesis PAT with `coder` scope (or `ANTHROPIC_AUTH_TOKEN` for compatibility) |
| `SYNESIS_YARN_MODEL` | No | Default `synesis-core` (tiers: `synesis-pulse`, `synesis-core`, `synesis-horizon`) |
| `SYNESIS_YARN_ACP_ENABLE_THINKING` | No | When `true` / `1` / `yes`, the bridge sets `enable_thinking: true` on `POST /v1/chat/completions` (same effect as `SYNESIS_YARN_ENABLE_THINKING`). Use when the resolved coder tier supports extended thinking (for example Qwen3 `enable_thinking` or DeepSeek-class reasoning). |
| `SYNESIS_YARN_ENABLE_THINKING` | No | Alias recognized by the bridge for the same `enable_thinking` request field (if `SYNESIS_YARN_ACP_ENABLE_THINKING` is unset). |
| `SYNESIS_YARN_ACP_INCLUDE_REASONING` | No | Default `true`. When `false`, the bridge does not prefix the ACP transcript with a **Model reasoning** section if Yarn returns `reasoning_content` (answer text is unchanged). |

`SYNESIS_CODER_URL` is accepted as an alias for `SYNESIS_YARN_URL`.

## Run

```bash
export SYNESIS_YARN_URL="https://coder.example.com"
export SYNESIS_YARN_TOKEN="your-pat"
node /path/to/synesis/base/yarn-ts/dist/acp/synesis-yarn-acp.js
```

The process reads/writes **NDJSON** on stdin/stdout per the ACP TypeScript SDK.

## Behavior

- **Sessions**: Each ACP session maps to a Yarn conversation id via body `conversation_id` and `metadata.synesis_conversation_id`.
- **Execution context (first-class)**: On `initialize`, the bridge records **clientInfo** (name/version) and merges safe hints from **`_meta`** into Yarn `metadata` (for example `synesis_runtime.platform` / `os_version` / `shell`, `synesis_git_summary`). On **`newSession`**, it maps **`cwd`** → `synesis_shell_cwd`, **`additionalDirectories[0]`** (or `cwd`) → `synesis_project_root`, and records MCP server / extra-root **counts** under `synesis_acp_session` (no secrets). See [SESSION_EXECUTION_CONTEXT.md](SESSION_EXECUTION_CONTEXT.md).
- **Prompts**: User text is appended to an OpenAI-style message list; each turn calls **`POST /v1/chat/completions`** with `stream: false`. Assistant **text** is replayed to the ACP client as `agent_message_chunk` notifications.
- **Model reasoning (thinking)**: The bridge does not consume SSE. If Yarn returns a non-stream JSON **`message.reasoning_content`** (OpenAI-compatible extension: chain-of-thought separate from `content`), the bridge can emit a markdown **“Model reasoning”** block before the main answer, then the usual answer text. Empty `content` with only `reasoning_content` is treated as a valid turn (no spurious “empty assistant” error). For HTTPS streaming and delta shape, see [CLIENTS.md](CLIENTS.md) and `base/yarn-ts/README.md` (coder frontend: OpenAI `reasoning_content` on stream chunks, Claude Messages `thinking` blocks on SSE).
- **Tool loop (in one `session/prompt`)**: When the model returns OpenAI `tool_calls`, the bridge emits ACP `tool_call` / `tool_call_update`, executes **Read**, **Write**, and **Bash** against the editor via ACP **`fs/read_text_file`**, **`fs/write_text_file`**, and **`terminal/create`** (then `wait_for_exit` + `current_output`), appends `role: "tool"` messages, and **calls `/v1/chat/completions` again** until the model stops requesting tools (bounded rounds). Other tool names (Edit, Grep, …) return a structured “not executed locally” result so the model can adapt. Requires a client that implements those ACP capabilities.

## Per-editor setup

- [Zed](ACP_ZED.md)
- [JetBrains](ACP_JETBRAINS.md)
- [OpenCode](ACP_OPENCODE.md)
- [Neovim (Avante / CodeCompanion)](ACP_NEOVIM.md)
- [HTTP-first clients (Cursor, VS Code, Roo, Claude Code)](ACP_HTTP_CLIENTS.md)

## Cloudflare / edge

See [Cloudflare Edge Hardening](../CLOUDFLARE_EDGE_HARDENING.md) — section *Coder frontend: HTTPS vs Agent Client Protocol (ACP)*.
