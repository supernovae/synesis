# Agent Client Protocol (ACP) with Synesis

This document describes the **Synesis ACP bridge** (`synesis-yarn-acp`): a small process that speaks the [Agent Client Protocol](https://agentclientprotocol.com/) over **stdio** (JSON-RPC) and forwards work to the **Synesis coder frontend** (`yarn-ts`) over **HTTPS** using the Anthropic Messages API (`POST /v1/messages`).

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

`SYNESIS_CODER_URL` is accepted as an alias for `SYNESIS_YARN_URL`.

## Run

```bash
export SYNESIS_YARN_URL="https://coder.example.com"
export SYNESIS_YARN_TOKEN="your-pat"
node /path/to/synesis/base/yarn-ts/dist/acp/synesis-yarn-acp.js
```

The process reads/writes **NDJSON** on stdin/stdout per the ACP TypeScript SDK.

## Behavior

- **Sessions**: Each ACP session maps to a Yarn conversation id via `metadata.synesis_conversation_id`.
- **Prompts**: User text is forwarded; assistant **text** is streamed in chunks as ACP `agent_message_chunk` notifications.
- **Tool calls**: Model `tool_use` blocks are surfaced as ACP `tool_call` updates. **Tool execution** is still performed by the **client** (editor); the next turn should supply tool results per your editor’s ACP flow. Full tool-loop parity with Claude Code over HTTP may require additional work.

## Per-editor setup

- [Zed](ACP_ZED.md)
- [JetBrains](ACP_JETBRAINS.md)
- [OpenCode](ACP_OPENCODE.md)
- [Neovim (Avante / CodeCompanion)](ACP_NEOVIM.md)
- [HTTP-first clients (Cursor, VS Code, Roo, Claude Code)](ACP_HTTP_CLIENTS.md)

## Cloudflare / edge

See [Cloudflare Edge Hardening](../CLOUDFLARE_EDGE_HARDENING.md) — section *Coder frontend: HTTPS vs Agent Client Protocol (ACP)*.
