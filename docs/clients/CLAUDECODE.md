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

**How a request picks a tier** (in order):

1. **Explicit Synesis tier** — if `model` is exactly `synesis-pulse`, `synesis-core`, or `synesis-horizon`, that tier is used (subject to high-risk rules that block choosing Pulse alone).
2. **Claude-style model id** — if `model` contains family substrings, Yarn maps it to a tier the same way: `haiku` → Pulse, `sonnet` → Core, `opus` → Horizon. Optional word aliases: `tiny` / `small` → Pulse, `medium` / `balanced` → Core, `large` → Horizon.
3. **Server map override** — set `SYNESIS_YARN_CLAUDE_TIER_MAP` on Yarn to a JSON object of substring needles → tier (e.g. `{"my-beta":"synesis-pulse"}`). Longer keys win before built-in family rules.
4. Otherwise **phase and evidence routing** applies (implementation vs planning vs validation, risk, recall, etc.).

For a **fixed** tier name in the Claude Code picker regardless of Anthropic labels, use `ANTHROPIC_CUSTOM_MODEL_OPTION=synesis-core` (or `synesis-pulse` / `synesis-horizon`) as in the quick start.

## Listing models

- **In Claude Code**: use the client’s `/models` **slash command** in the terminal UI. That is not a shell executable; do not run it with Bash.
- **Over HTTP**: `GET https://<your-coder-host>/v1/models` returns an OpenAI-style list whose `id` values are the three Synesis tier names (discovery does not require auth; `POST /v1/messages` still requires your PAT).

## Key yarn-ts settings

These are the most relevant runtime controls for Claude Code behavior:

- `SYNESIS_YARN_CLAUDE_TIER_MAP` (optional JSON: substring needle → `synesis-pulse` | `synesis-core` | `synesis-horizon`)
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

## Workspace and execution context (optional)

Yarn-ts can merge structured **project** and **shell** paths into the model context so tiers (for example Qwen3) anchor file tools. Full field names and precedence are in [SESSION_EXECUTION_CONTEXT.md](SESSION_EXECUTION_CONTEXT.md).

**Headers (HTTP)**

| Header | Meaning |
|--------|---------|
| `x-synesis-project-root` | Repository / workspace root (absolute path on the client) |
| `x-synesis-workspace-root` | Same as `x-synesis-project-root` (backward compatible) |
| `x-synesis-shell-cwd` | Current task directory (often `pwd`) |

**Anthropic `metadata` (same keys, snake_case)**

- `synesis_project_root`, `synesis_shell_cwd`
- Optional: `synesis_runtime` (`platform`, `os_version`, `shell`), `synesis_git_summary`, `synesis_client_model_label`, `synesis_knowledge_cutoff`

Claude Code does **not** send these by default. Use a [Claude Code hook](https://code.claude.com/docs/en/hooks) or a small reverse proxy in front of `ANTHROPIC_BASE_URL` to attach headers or merge `metadata` on each `POST /v1/messages` (for example set `x-synesis-project-root` from `git rev-parse --show-toplevel` and `x-synesis-shell-cwd` from `pwd`).

**Server-side**

- `SYNESIS_YARN_SESSION_PATH_HINTS_IN_WORKING_FRAME` (default `true`): echo `project_root` / `shell_cwd` inside `<WORKING_FRAME>` when provided.
- `SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE` (default `false`): on the Claude **streaming** path, clamp Read/Write/Edit/Update `file_path` to resolve under `project_root` when it is known.

## Bash and directory containment

Yarn-ts does **not** execute tools; it only returns tool calls to the client. **Hard** rules on `cd`, destructive `rm`, or leaving the repo must be enforced on the machine that runs tools—for example a `PreToolUse` hook in Claude Code that blocks or rewrites commands. See the [hooks reference](https://code.claude.com/docs/en/hooks).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing required header: anthropic-version` | Non-Claude client shape or raw call missing header | Use Claude Code client or include required Anthropic headers |
| `401 Unauthorized` | Missing/invalid PAT | Regenerate PAT with `coder` scope |
| Tool search not working | Default `disable` mode | Set `ENABLE_TOOL_SEARCH=true` client-side and `SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE=passthrough` server-side |
| Loop message asking for guidance | Safe-fail loop guard triggered | Provide one corrective user instruction (tool install, alternate command, narrower repair plan) |

## Related docs

- [Session execution context contract](SESSION_EXECUTION_CONTEXT.md)
- [Client setup overview](CLIENTS.md)
- [Claude compatibility design note](../claude_code_compat.md)
- [Yarn TS runtime](../YARN_RUNTIME.md)
