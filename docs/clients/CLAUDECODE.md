# Claude Code with Synesis Coder

This guide explains how to connect Claude Code to the Synesis **coder frontend**
(`yarn-ts`) and what to expect from the protocol.

## Terminology

- **Coder frontend**: `yarn-ts` for IDE/agent workflows (Claude Code, Cursor, Codex CLI, etc.).
- **Chat frontend**: Planner OpenAI surface for conversational apps and UIs (for example Open WebUI or custom chat apps).

## Prerequisites

- Synesis coder frontend (`yarn-ts`) deployed and reachable, for example:
  `https://coder.synesis.example.com`
- A Synesis PAT with `coder` scope from Admin > Security > PATs, or an OIDC access token for client `synesis-harness` when Yarn OIDC is enabled.

## Quick start

```bash
# Base URL should point to your Yarn TS host (no /v1 suffix)
export ANTHROPIC_BASE_URL="https://coder.synesis.example.com"

# Synesis PAT with coder scope, or an OIDC access token from client synesis-harness
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

## Extended thinking / reasoning (streaming)

When the upstream model emits separate reasoning (Vercel AI SDK **reasoning** stream parts), Yarn maps that to the Anthropic **Messages** SSE shape your client expects:

- **`thinking` blocks** — `content_block_start` / `content_block_delta` with `type: "thinking"` and `thinking_delta` updates, then `content_block_stop`.

The request may include Anthropic fields Yarn forwards to the provider, such as **`thinking`** and **`enable_thinking`**, and tier **sampling defaults** (Admin model registry) can set `enable_thinking` for thinking-capable tiers.

For the **OpenAI** surface (other tools), the same engine exposes **`reasoning_content`** on streaming and non-stream responses instead of the Anthropic block types. See [CLIENTS.md](CLIENTS.md) and `base/yarn-ts/README.md`.

## Model tier mapping

Yarn exposes three client-facing coder tiers:

- `synesis-pulse` (haiku-class)
- `synesis-core` (sonnet-class, default)
- `synesis-horizon` (opus-class)

**How a request picks a tier** (in order):

1. **Explicit Synesis tier** — if `model` is exactly `synesis-pulse`, `synesis-core`, or `synesis-horizon`, that tier is used (subject to high-risk rules that block choosing Pulse alone).
2. **Short names (including Claude Code `/model`)** — exact match, case-insensitive: `pulse`, `core`, `horizon` (maps to the three Synesis tiers), or the **Admin role-style** ids `coder-pulse`, `coder-core`, `coder-horizon` (same mapping). For example, `/model horizon` → `synesis-horizon`, `/model coder-horizon` → `synesis-horizon`.
3. **Claude-style model id** — if `model` contains family substrings, Yarn maps it to a tier the same way: `haiku` → Pulse, `sonnet` → Core, `opus` → Horizon. Optional word aliases: `tiny` / `small` → Pulse, `medium` / `balanced` → Core, `large` → Horizon.
4. **Server map override** — set `SYNESIS_YARN_CLAUDE_TIER_MAP` on Yarn to a JSON object of substring needles → tier (e.g. `{"my-beta":"synesis-pulse"}`). Longer keys win before built-in family rules.
5. Otherwise **phase and evidence routing** applies (implementation vs planning vs validation, risk, recall, etc.).

For a **fixed** tier name in the Claude Code picker regardless of Anthropic labels, use `ANTHROPIC_CUSTOM_MODEL_OPTION=synesis-core` (or `synesis-pulse` / `synesis-horizon`) as in the quick start.

## Listing models

- **In Claude Code**: use the client’s `/models` **slash command** in the terminal UI. That is not a shell executable; do not run it with Bash.
- **Over HTTP**: `GET https://<your-coder-host>/v1/models` returns an OpenAI-style list whose `id` values are the three Synesis tier names (discovery does not require auth; `POST /v1/messages` still requires your PAT).

## API-equivalent Claude commands (server-side)

Yarn now exposes authenticated command-compat endpoints for clients that want
server-side command behavior without relying on local proxy logic.

- `GET /v1/claude/bootstrap?preset=default|go-strict|ts-strict|python-strict`
  - Returns a versioned `CLAUDE.md` template payload.
- `GET /v1/claude/model-resolution?model=<id>`
  - Returns the resolved Synesis tier (`synesis-pulse|synesis-core|synesis-horizon`) and resolution reason.
- `POST /v1/claude/commands/execute`
  - Command envelope for `init`, `model`, and `compact`.
  - Includes structured fallback for unsupported commands (`supported=false`) and whether a command is likely client-local.

Example:

```bash
curl -sS -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
  "https://<your-coder-host>/v1/claude/bootstrap?preset=default"
```

```bash
curl -sS -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
  "https://<your-coder-host>/v1/claude/model-resolution?model=claude-sonnet-4-5"
```

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

### Synesis reference hook and proxy (optional)

The repository ships a copy-paste bundle under **[`clients/claude-code/`](../../clients/claude-code/)** (not under `docs/`, so raw GitHub URLs stay short):

- **`synesis-context-hook.sh`** — runs on **SessionStart** and **CwdChanged**; writes **`.claude/synesis-context.json`** with `synesis_project_root`, `synesis_shell_cwd`, `synesis_runtime`, and optional `synesis_git_summary`. On SessionStart it also adds `additionalContext` for the local model (this does **not** replace Yarn metadata on the wire).
- **`settings.json.snippet`** — merge into `.claude/settings.json` after installing the script to `.claude/hooks/`.
- **`synesis-anthropic-proxy.mjs`** — optional local **HTTP** proxy on `127.0.0.1` that reads the sidecar file and **merges** those fields into `metadata` on each `POST /v1/messages` (and `/v1/chat/completions`) before forwarding to your real **`SYNESIS_UPSTREAM`** Yarn URL. Point **`ANTHROPIC_BASE_URL`** at the proxy (keep **`ANTHROPIC_AUTH_TOKEN`** as your Synesis PAT).

Hooks alone cannot set HTTP headers or API `metadata`; the proxy closes the loop for Yarn-ts. Requires **`jq`**. See **[`clients/claude-code/README.md`](../../clients/claude-code/README.md)** for install steps, fixtures, and security notes.

**Server-side**

- `SYNESIS_YARN_SESSION_PATH_HINTS_IN_WORKING_FRAME` (default `true`): echo `project_root` / `shell_cwd` inside `<WORKING_FRAME>` when provided.
- `SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE` (default `false`): on the Claude **streaming** path, clamp Read/Write/Edit/Update `file_path` to resolve under `project_root` when it is known.

## Bash and directory containment

Yarn-ts does **not** execute tools; it only returns tool calls to the client. **Hard** rules on `cd`, destructive `rm`, or leaving the repo must be enforced on the machine that runs tools—for example a `PreToolUse` hook in Claude Code that blocks or rewrites commands. See the [hooks reference](https://code.claude.com/docs/en/hooks).

## Plan file management

Claude Code stores long-running feature plans in `~/.claude/plans/` as markdown
files with YAML frontmatter. Yarn assists with plan lifecycle to prevent common
failure modes where the model loses awareness of the plan mid-session, re-reads
the file in a loop, or fails to update task status.

### What Yarn does today

**Read annotation** — When Yarn detects a successful plan file read (path
matches `/.claude/plans/`), it appends a `<SYNESIS_PLAN_LOADED>` block to the
tool result with structured instructions: parse the task list, display a
progress summary, state the next task, and *do not re-read*.

**Content preservation** — Plan file reads are exempt from every reduction and
pruning layer so the original content is never evicted or stubbed:

| Layer | Protection |
|-------|-----------|
| Tool result reducer | Read tools exempt from task pruning, registry reduction, and size compaction |
| Content-addressed dedup | `isPlanFile` guard skips deduplication for plan paths |
| Transcript pruning | `isPlanFilePath` guard in file-read dedup (Strategy 2), stale-eviction (Strategy 3), and near-duplicate collapse (Strategy 5) |

**Client cache stub recovery** — When the Claude Code client returns
`"Unchanged since last read"` instead of content, `applyReadCacheStubRemediation`
replaces the stub with a recovery hint directing the model to use `cat` to
retrieve the file.

**Dedup stub remediation** — `remediatePlanFileStubs` runs as a post-dedup
safety net: if a plan file is accidentally replaced by a `<FILE_UNCHANGED>`
stub, the stub is replaced with a recovery hint that includes the file path.

**Cross-session continuity** — When a plan file is loaded, its path is persisted
to Postgres (`yarn_session_continuity.plan_file_path`). On session restore, the
path appears in `<SESSION_RECALL>` and `<synesis_plan_progress>` blocks with an
instruction to re-read the plan and display its status summary.

**Governor backstops** — The execution governor catches patterns where the model
gets stuck around plan work:

- `verification_stall_no_edit` — pauses when the model runs build/test in a loop
  without making code edits (common when the model "forgets" the plan).
- `verbal_intent_without_action` — pauses when the model repeatedly declares
  intent ("I'll finish the implementation...") without any edits or task updates.
- `completion_claim_requires_task_update` — pauses when the model claims work is
  done but hasn't called `TaskUpdate`/`TodoWrite` to mark tasks complete.

### Known issues and future work

| Issue | Status | Notes |
|-------|--------|-------|
| **Client cache stubs lack path context** — `"Unchanged since last read"` from the client contains no file path; recovery relies on regex extraction from surrounding content, which can miss. | Mitigated | `annotatePlanFileReads` now resolves paths from `tool_call_id` arguments and replaces cache stubs / guardrails with plan-specific "already loaded" guidance instead of generic "use cat". |
| **Plan annotation only fires on successful reads** — If the original read was successful but the model re-reads and only gets cache stubs, the `<SYNESIS_PLAN_LOADED>` annotation never fires on the stubs. The model must rely on the original annotated read still being in context. | Fixed | `annotatePlanFileReads` now detects plan file stubs (short text, "unchanged", or guardrail content) and replaces them with a `<SYNESIS_PLAN_LOADED cached="true">` block that tells the model the content is unchanged and to not re-read. |
| **No server-side plan file content caching** — Yarn does not cache the plan file content itself; it relies entirely on the client's tool execution. If the client never successfully reads the file, Yarn has no fallback. | Open | A server-side plan content cache (keyed by path + session) would allow Yarn to inject plan content even when client reads fail. Requires careful cache invalidation when the plan file is edited. |
| **Task update detection is text-heuristic** — Governor rules detect completion claims via regex ("I'll...", "done", "complete"). Unusual phrasing can evade detection. | Open | Structured plan-graph integration (tracking `PlanGraph` stage transitions) would be more reliable than text heuristics. |
| **Multiple plan files in one session** — If a user loads multiple plan files, only the last path is persisted to continuity. Earlier plans are forgotten on session restore. | Open | Support a list of plan file paths, or tie plan paths to `PlanGraph` instances. |
| **Plan file edits by the model** — When the model writes back to the plan file (updating task status), the write tool result does not trigger annotation. The model may lose awareness of the plan state after its own edit. | Open | Detect plan file writes and re-inject the plan annotation or a "plan updated successfully" acknowledgment. |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing required header: anthropic-version` | Non-Claude client shape or raw call missing header | Use Claude Code client or include required Anthropic headers |
| `401 Unauthorized` | Missing/invalid PAT | Regenerate PAT with `coder` scope |
| Tool search not working | Default `disable` mode | Set `ENABLE_TOOL_SEARCH=true` client-side and `SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE=passthrough` server-side |
| Loop message asking for guidance | Safe-fail loop guard triggered | Provide one corrective user instruction (tool install, alternate command, narrower repair plan) |
| `API error: 502` with a **Cloudflare** HTML page (e.g. “bad gateway”, Ray ID) | **Not** tier resolution inside Yarn: Cloudflare could not get a good response from the **origin** (Yarn/LB), or the origin **timed out**. `synesis-horizon` is not a special case in code — the same 502 can appear for any path if the edge is unhealthy. | 1) From your machine, verify Yarn answers with JSON: `curl -sS -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" "https://<host>/v1/claude/model-resolution?model=synesis-horizon"` (expect `claude_model_resolution` JSON). 2) If that fails, check **`synesis-yarn` pods** and the **Route/ingress** behind `coder.kybern.dev` (readiness, restarts, Cloudflare **origin** pool / tunnel). 3) If GET works but chat fails after selecting Horizon, check **Admin → model registry**: `coder-horizon` / `synesis-horizon` must point to a **reachable** OpenAI-compatible endpoint; a broken **upstream** for that tier can surface as 502 on `POST /v1/messages` with a JSON `upstream_error` from Yarn, or 502 at the edge if the pod crashes mid-request. 4) Optional: use the repo **[`clients/claude-code/synesis-anthropic-proxy.mjs`](../../clients/claude-code/synesis-anthropic-proxy.mjs)** — it can replace **HTML** error pages from the edge with a short **JSON** error so the CLI does not dump a full Cloudflare page. |

## Important boundary: slash commands vs API

Claude Code slash commands (for example `/init`, `/model`, `/compact`) are part
of the client UX. Synesis cannot intercept keystrokes from the Claude terminal
UI directly. The endpoints above are API equivalents that wrappers/integrations
can call explicitly.

## Related docs

- [Synesis Claude Code hook + proxy (repo `clients/claude-code/`)](../../clients/claude-code/README.md)
- [Session execution context contract](SESSION_EXECUTION_CONTEXT.md)
- [Client setup overview](CLIENTS.md)
- [Yarn TS runtime](../../base/yarn-ts/README.md)
