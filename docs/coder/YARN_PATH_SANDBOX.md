# Yarn Path Sandbox

> **Status:** Shipped (Apr 2026)
> **Code:** `base/yarn-ts/src/path-governance/path-sandbox.ts`
> **Tests:** `base/yarn-ts/tests/path-sandbox.test.ts` (43 tests)
> **Config:** `SYNESIS_YARN_PATH_SANDBOX_ENABLED` (default `true`)

## Problem

Coding agents can read files outside the project root — including another project's `CLAUDE.md`, `.cursorrules`, or `AGENTS.md`. When these leak into the session context they poison the agent's behavior with stale/irrelevant instructions. System paths (`/etc`, `/usr`, `/var`) and other users' home directories also represent security boundaries that should not be crossed.

## Design Principles

1. **Project root is the sandbox root** — always has full read+write, no questions asked.
2. **Deny list beats allow list** — but explicit allows beat deny (for `$TMPDIR` carve-out).
3. **Allow list beats implicit block** — everything not in allow/deny is blocked.
4. **Agent config isolation** — `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, `.windsurfrules`, `.aider.conf.yml`, `GEMINI.md` are only readable from the project root or their harness's own config directory.
5. **Nudge over block for temp** — `/tmp` is allowed but the sandbox nudges toward `/tmp/<project-name>/` for isolation.

## Harness Compatibility Matrix

Researched across 7 major coding harnesses (Apr 2026):

| Harness | Config Dir | Session/Tool Temp | Write Paths |
|---------|-----------|-------------------|-------------|
| **Claude Code** | `~/.claude/**` | `/tmp/claude`, `/private/tmp/claude` | `~/.claude/plans/**`, `~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.claude/history/**` |
| **Cursor** | `~/.cursor/**` | — | `.cursor/rules/`, `.cursor/skills/`, `.cursor/agents/` (within project) |
| **Gemini CLI** | `~/.gemini/**` | `~/.gemini/tmp/` | `~/.gemini/tmp/**` |
| **Codex CLI** | `~/.codex/**` | `$TMPDIR`, `/tmp` | `writable_roots` in `~/.codex/config.toml` |
| **OpenCode** | `~/.config/opencode/**` | `OPENCODE_STATE_DIR` env var | Per-session working directories |
| **Windsurf** | `~/.codeium/**` | — | — |
| **Aider** | `~/.aider/**` | — | — |
| **VS Code** | `~/.vscode/**` | — | — |
| **code-server** | `~/.local/share/code-server/**` | — | — |

### Key Cross-Harness Patterns

- **All harnesses** store their config under `~/.<harness-name>/` in the user's home directory.
- **Claude Code** hardcodes `/tmp/claude` and `/private/tmp/claude` as write paths.
- **Codex CLI** explicitly uses `$TMPDIR` (macOS: `/private/var/folders/.../T/`).
- **Gemini CLI** uses `~/.gemini/tmp/` and always includes `Storage.getGlobalTempDir()` in sandbox.
- **Cursor** defines protected paths in `sandbox.json` (`additionalReadwritePaths`, `additionalReadonlyPaths`).
- **No harness** has a standardized per-session temp directory convention yet (Claude Code issue #25292 requests this).

## Allowed Paths

### Read Access

| Path Pattern | Rationale |
|-------------|-----------|
| `<project_root>/**` | Sandbox root — always wins |
| `~/.claude/**` | Claude Code config, plans, history |
| `~/.cursor/**` | Cursor IDE rules, skills, settings |
| `~/.gemini/**` | Gemini CLI config |
| `~/.codex/**` | Codex CLI config |
| `~/.config/opencode/**` | OpenCode config |
| `~/.codeium/**` | Windsurf / Codeium config |
| `~/.aider/**` | Aider history and config |
| `~/.vscode/**` | VS Code settings |
| `~/.local/share/code-server/**` | code-server config |
| `/tmp/**` | Agent scratch files, build output |
| `/private/tmp/**` | macOS symlink target for /tmp |
| `$TMPDIR/**` | macOS session temp (dynamically resolved) |

### Write Access

| Path Pattern | Rationale |
|-------------|-----------|
| `<project_root>/**` | Sandbox root — always wins |
| `~/.claude/plans/**` | Claude Code plan files |
| `~/.claude/settings.json` | Claude Code settings |
| `~/.claude/settings.local.json` | Claude Code local settings |
| `~/.claude/history/**` | Claude Code session history |
| `~/.gemini/tmp/**` | Gemini CLI tool temp |
| `/tmp/**` | Agent scratch files |
| `/private/tmp/**` | macOS symlink target |
| `$TMPDIR/**` | macOS session temp |

## Blocked Paths

| Path Pattern | Rationale |
|-------------|-----------|
| `/etc/**` | System config |
| `/usr/**` | System binaries/libs |
| `/var/**` | System state (but `$TMPDIR` carve-out applies) |
| `/proc/**` | Linux process info |
| `/sys/**` | Linux sysfs |
| `/dev/**` | Device files |
| `/private/var/**` | macOS system state (but `$TMPDIR` carve-out applies) |
| `/private/etc/**` | macOS system config |
| `/System/**` | macOS system |
| `/Library/**` | macOS system libraries |
| `/Users/<other>/**` | Other users' home directories |
| `/home/<other>/**` | Other users' home directories |

## Agent Config Isolation

The following filenames are recognized as agent config files and are **only** allowed from the project root or their harness's own `~/.harness/` directory:

```
CLAUDE.md, claude.md, Claude.md
.cursorrules, cursorrules
AGENTS.md, agents.md
.windsurfrules
.gemini, GEMINI.md
.aider.conf.yml
CONVENTIONS.md, RULES.md
```

If an agent tries to read `CLAUDE.md` from `/Users/you/src/other-project/CLAUDE.md`, it receives:

```
Reading agent config from outside the project is blocked for safety.
If you need a CLAUDE.md, place it inside your project root at
<project_root>/CLAUDE.md.
```

## macOS `$TMPDIR` Carve-Out

On macOS, `$TMPDIR` resolves to something like `/private/var/folders/ab/cd1234/T/` — which falls under the blocked `/private/var/**` prefix. The sandbox resolves `$TMPDIR` at startup and adds it to the allow list. The evaluation order ensures explicitly allowed paths are checked before the deny list:

1. Project root check (always wins)
2. Explicit allow-list pre-check (catches `$TMPDIR` under `/private/var/`)
3. Deny list check (skipped if pre-check passed)
4. Agent config isolation check
5. Other-user home directory check
6. Full allow-list check (with `/tmp` nudge)
7. Outside-sandbox fallback block

## `/tmp` Nudge Toward Project Scope

When an agent writes to `/tmp/scratch.txt`, the operation is allowed but the sandbox attaches a nudge:

```
Prefer using /tmp/<project-name>/ for temp files to avoid collisions
with other projects.
```

The project-scoped temp dir is derived from `path.basename(projectRoot)`, e.g.:
- `/Users/me/src/synesis` → `/tmp/synesis/`
- `/Users/me/src/cool-app` → `/tmp/cool-app/`

Paths already under the scoped subdir get no nudge.

## Integration

The sandbox is wired into all 4 `governToolCall` call sites in `base/yarn-ts/src/index.ts` (both OpenAI and Claude paths, both streaming and non-streaming). When a path is blocked, the agent receives a `Synesis_Error_PathSandbox` structured error with:

- `reason`: why the path was blocked
- `blocked_path`: the offending path
- `resolved_path`: what it resolved to after `~` expansion
- `operation`: read or write
- `message`: human-readable explanation
- `nudge`: optional actionable guidance

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SYNESIS_YARN_PATH_SANDBOX_ENABLED` | `true` | Enable/disable path sandbox enforcement |
| `SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE` | `true` | Clamp file tool paths to project root (pre-existing, complementary) |

## Future Considerations

- **Per-harness write path expansion**: As harnesses add writable config paths (e.g., Cursor `.cursor/agents/`), the write allowlist should be updated.
- **`additionalDirectories` passthrough**: If the client session metadata includes Claude Code's `additionalDirectories` or Cursor's `additionalReadwritePaths`, the sandbox could dynamically expand.
- **Per-session temp**: If a standard session-scoped temp directory convention emerges, the sandbox should adopt it (tracking Claude Code issue #25292).
- **`.env` file protection**: Gemini CLI blocks `.env` and `.env.*` files entirely. Consider adding this as an optional deny pattern.
