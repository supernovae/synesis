# Terminal interception (Yarn MCP + ACP)

Synesis applies **bounded** preprocessing to CLI output so agents get **actionable** feedback instead of hanging or drowning in TTY-shaped logs.

## Layers

1. **Non-interactive defaults** — merged into `execFile` env for workspace MCP tools when a key is unset or empty (see below).
2. **Output shaping** — linear-pass: strip common ANSI escapes, collapse `\r` progress lines, collapse repeated lines. Controlled by `SYNESIS_YARN_TERMINAL_SHAPING_ENABLED` (default on).
3. **Classifiers** — small curated patterns for sudo/pager/interactive/network; plus heuristics from shaping stats (e.g. heavy repetition).
4. **Structured fields** — `terminalSignals` on `run_*` / `format_code` results; `terminal_signals` on `run_in_sandbox` and ACP Bash JSON.
5. **ACP Bash wall-clock watchdog** — `SYNESIS_YARN_ACP_BASH_TIMEOUT_MS` (default 600000) races `waitForExit`; on timeout returns `killed_reason: "wall_clock_timeout"` and shaped output.

## Default tool environment (mirror for local / ACP terminals)

When running MCP preset commands, these are applied if not already set:

| Variable | Value |
|----------|--------|
| `CI` | `1` |
| `DEBIAN_FRONTEND` | `noninteractive` |
| `NEEDRESTART_MODE` | `a` |
| `GIT_TERMINAL_PROMPT` | `0` |
| `GIT_PAGER` | `cat` |
| `PIP_NO_INPUT` | `1` |
| `PYTHONUNBUFFERED` | `1` |
| `npm_config_yes` | `true` |
| `COREPACK_ENABLE_DOWNLOAD_PROMPT` | `0` |
| `NO_COLOR` | `1` |
| `FORCE_COLOR` | `0` |

Implementation: [`base/yarn-ts/src/terminal/tool-env.ts`](../../base/yarn-ts/src/terminal/tool-env.ts).

## Configuration

| Env | Purpose |
|-----|---------|
| `SYNESIS_YARN_TERMINAL_SHAPING_ENABLED` | `false` disables ANSI/`\\r`/repeat shaping (default on). |
| `SYNESIS_YARN_ACP_BASH_TIMEOUT_MS` | Max wait for ACP `Bash` `waitForExit` (default 600000). |

## Out of scope

- Auto-answering interactive prompts (unsafe).
- Idle timeouts without streaming stdout (deferred until a streaming runner exists).
