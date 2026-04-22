# Claude Code — Synesis session context

Hooks and an optional local proxy so Yarn-ts receives [session execution context](../../docs/clients/SESSION_EXECUTION_CONTEXT.md): `project_root`, `shell_cwd`, `synesis_runtime`, and optional `synesis_git_summary`.

## Why hook + proxy?

Claude Code hooks **cannot** add HTTP headers or `metadata` on outbound `POST /v1/messages` requests. They can:

1. **Write a sidecar JSON file** (this hook) and optionally add **in-session** `additionalContext` on `SessionStart`.
2. **Merge that file into API requests** via a tiny **local reverse proxy** (`synesis-anthropic-proxy.mjs`) so Yarn sees the same fields as other clients.

See [Claude Code hooks](https://code.claude.com/docs/en/hooks) for security implications (hooks run with your user permissions).

## Requirements

- `bash`, `jq` ([jqlang](https://jqlang.org/))
- `git` (optional; improves `project_root` and `synesis_git_summary`)
- Node.js 18+ (for the optional proxy only)

## Install the hook

1. Copy **`synesis-context-hook.sh`** into your repo at **`.claude/hooks/synesis-context-hook.sh`**.
2. `chmod +x .claude/hooks/synesis-context-hook.sh`
3. Merge **`settings.json.snippet`** into **`.claude/settings.json`** (project or user scope), or add the `hooks` block by hand.

The snippet invokes `"$CLAUDE_PROJECT_DIR/.claude/hooks/synesis-context-hook.sh"` — the path Claude Code documents for project-scoped hooks.

## What gets written

On **SessionStart** and **CwdChanged**, the hook writes **`.claude/synesis-context.json`** under the project (`$CLAUDE_PROJECT_DIR`):

| Field | Source |
|-------|--------|
| `synesis_project_root` | `git rev-parse --show-toplevel` from cwd, else cwd |
| `synesis_shell_cwd` | Hook payload `cwd` or `new_cwd` |
| `synesis_runtime` | `platform`, `os_version`, `shell` |
| `synesis_git_summary` | Short `git status -sb` (truncated) |

**SessionStart** also prints JSON with `hookSpecificOutput.additionalContext` so the model sees a one-line summary in the transcript (this is **not** a substitute for Yarn metadata).

## Manual checks (fixtures)

From this directory:

```bash
chmod +x synesis-context-hook.sh
export CLAUDE_PROJECT_DIR="$(pwd)/_test_proj"
mkdir -p "$CLAUDE_PROJECT_DIR"
cat fixtures/session-start.json | ./synesis-context-hook.sh
cat "$CLAUDE_PROJECT_DIR/.claude/synesis-context.json"
```

```bash
cat fixtures/cwd-changed.json | CLAUDE_PROJECT_DIR="$(pwd)/_test_proj" ./synesis-context-hook.sh
```

## Optional: Anthropic proxy for Yarn

Run from the **repository root** where `.claude/synesis-context.json` exists (after at least one hook run), or set **`SYNESIS_CONTEXT_FILE`** to that file’s absolute path.

```bash
export SYNESIS_UPSTREAM="https://your-coder-host.example.com"
node /path/to/synesis-anthropic-proxy.mjs
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
```

Keep your existing **`ANTHROPIC_AUTH_TOKEN`** (Synesis PAT). The proxy listens on **127.0.0.1** only by default.

**502 / Cloudflare HTML errors:** If the edge (Cloudflare) returns an **HTML** “bad gateway” page, Claude Code’s terminal may show that entire page. This proxy **replaces** HTML error bodies with a short **`application/json`** `bad_gateway` error (Anthropic-style) so the failure is readable. The underlying problem is still **origin/edge health** (Yarn, ingress, or model upstream) — see [CLAUDECODE.md — Troubleshooting](../../docs/clients/CLAUDECODE.md#troubleshooting).

Environment:

| Variable | Default |
|----------|---------|
| `SYNESIS_UPSTREAM` | (required) Yarn base URL, no `/v1` suffix |
| `SYNESIS_CONTEXT_FILE` | `$cwd/.claude/synesis-context.json` |
| `SYNESIS_PROXY_PORT` | `8787` |
| `SYNESIS_PROXY_HOST` | `127.0.0.1` |

## GitHub raw URLs

Stable paths in this repo, e.g. `clients/claude-code/synesis-context-hook.sh`, for `curl`/`wget` installs.
