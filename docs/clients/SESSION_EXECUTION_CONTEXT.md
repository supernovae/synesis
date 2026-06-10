# Session Execution Context

Session execution context is the client-to-Yarn contract for describing where a coding session is running: the workspace root, the current shell directory, runtime hints, and optional git state.

This exists because OpenAI Chat Completions and Anthropic Messages are model APIs, not IDE protocols. They do not define standard fields for "the user's project root", "the current terminal directory", "the active git branch", or "the shell this client is using". Those details usually live in the local client, editor, terminal, or agent harness. Yarn needs a small explicit metadata layer so server-side prompt guidance, path guards, tool behavior, telemetry, and session continuity can agree on the same workspace facts.

## Why It Matters

Without a reliable execution context, coding models tend to make expensive path mistakes:

- They prepend the workspace folder name to file-tool paths even when tools already resolve from that folder.
- They create nested duplicate directories such as `repo/repo/...`.
- They infer package or module names from host paths instead of project metadata.
- They read guessed files in empty workspaces before confirming what exists.
- They run build/test commands from the wrong shell directory.

Yarn uses this context to add a `<SESSION_EXECUTION_CONTEXT>` system block, enforce file-tool path boundaries when configured, recover session path hints across turns, and give guarded git workflows accurate repo state.

## Source Priority

Yarn can learn workspace context from several places. Explicit client metadata is the preferred source.

| Source | Reliability | How Yarn Uses It |
|--------|-------------|------------------|
| Request `metadata` | Best | Flat `synesis_*` fields are parsed directly from OpenAI-compatible or Anthropic-compatible request metadata. |
| HTTP headers | Best | Used when metadata is absent. Useful for reverse proxies and clients that cannot alter request bodies. |
| ACP bridge metadata | Best | The Synesis ACP bridge converts ACP session `cwd`, `additionalDirectories`, and safe `_meta` hints into the flat Yarn metadata keys. |
| Client system-message extraction | Fallback | Yarn can parse common environment blocks such as `Workspace Path:`, `Working directory:`, `OS Version:`, and `Shell:` from prior client messages. |
| Persisted session metadata | Fallback | Once a workspace context is known, Yarn can rehydrate it from session metadata on later turns. |
| Prior tool evidence | Last resort | Yarn can infer a root from a successful `pwd`, an absolute `cd`, or a duplicated absolute path shown in a file error. |
| `<PATH_HYGIENE>` fallback | Guardrail only | If no facts are known for a coder client, Yarn adds generic path hygiene guidance. This block does not contain real workspace facts. |

Synthetic workspace handshakes are currently disabled by default in Yarn. Clients should not rely on Yarn automatically asking the model to run `pwd` or `git rev-parse`; send metadata or headers whenever the client knows the workspace.

## Core Concepts

`project_root` is the stable workspace or repository boundary for the session. It should be an absolute path and should not change during a session unless the user actually moves to a different project.

`shell_cwd` is the current execution directory for shell commands and client-native file tools. It may be the same as `project_root` or a subdirectory inside it. Yarn drops `shell_cwd` if it is outside `project_root`.

`synesis_runtime` is optional prompt/debug context about the client runtime. It is not a security boundary.

Git facts are optional. Structured git fields are preferred, but Yarn can infer branch, dirty, untracked, ahead, and behind hints from a short `git status -sb` style summary.

## Transport Contract

Send flat metadata keys when possible. Metadata wins over headers for `project_root` and `shell_cwd`.

### Workspace Paths

| Field | Metadata Key | Header Key | Notes |
|-------|--------------|------------|-------|
| Project root | `synesis_project_root` | `x-synesis-project-root` | Absolute non-root path. |
| Project root alias | n/a | `x-synesis-workspace-root` | Legacy header alias. Used only when `x-synesis-project-root` is absent. |
| Shell cwd | `synesis_shell_cwd` | `x-synesis-shell-cwd` | Absolute path. Ignored when outside `project_root`. |

Use the flat keys above for direct Yarn requests. Older nested forms such as `synesis.projectRoot` are not part of the current direct request contract. Some bridge-specific `_meta` inputs, such as ACP `_meta`, may be normalized before Yarn sends the request to itself, but clients and proxies should emit the flat keys.

### Runtime Hints

Runtime hints are metadata-only.

| Metadata Key | Type | Purpose |
|--------------|------|---------|
| `synesis_runtime.platform` | string | Short platform label, for example `darwin`, `linux`, or `win32`. |
| `synesis_runtime.os_version` | string | Human-readable OS version when the client knows it. |
| `synesis_runtime.shell` | string | Shell path or shell name, for example `/bin/zsh`. |

### Git Hints

Structured git facts can be sent as metadata or headers.

| Fact | Metadata Key | Header Key |
|------|--------------|------------|
| Is git repo | `synesis_git_is_repo` | `x-synesis-git-is-repo` |
| Branch | `synesis_git_branch` | `x-synesis-git-branch` |
| Dirty worktree | `synesis_git_dirty` | `x-synesis-git-dirty` |
| Has untracked files | `synesis_git_has_untracked` | `x-synesis-git-has-untracked` |
| Ahead count | `synesis_git_ahead` | `x-synesis-git-ahead` |
| Behind count | `synesis_git_behind` | `x-synesis-git-behind` |

Boolean headers accept common boolean-like values such as `true`, `false`, `1`, `0`, `yes`, and `no`. Ahead/behind values are parsed as non-negative integers.

When structured facts are unavailable, clients may send:

| Metadata Key | Server Cap | Purpose |
|--------------|------------|---------|
| `synesis_git_summary` | 500 chars | Short git status summary, usually `git status -sb`. |
| `synesis_client_model_label` | 256 chars | Display/debug label for the client model. |
| `synesis_knowledge_cutoff` | 128 chars | Client-known knowledge cutoff label. |

## Normalization And Safety

Yarn normalizes path hints before using them:

- Paths must be strings, absolute, non-empty, non-root, free of control characters, and no longer than the server limit.
- POSIX paths are resolved with POSIX semantics; Windows absolute paths are normalized with Windows semantics.
- `shell_cwd` is retained only when it is inside `project_root` or when no `project_root` is known.
- Prompt-visible scalar fields are sanitized so they cannot inject XML-like system block boundaries.
- Git summaries are truncated and sanitized before prompt insertion.

These fields improve model behavior and server-side guardrails, but they are not authorization by themselves. Access control still depends on the authenticated user, route authorization, MCP/tool validation, file-tool governance, and the deployment sandbox.

## What Yarn Does With It

When any session execution field resolves, Yarn appends:

```text
<SESSION_EXECUTION_CONTEXT>
project_root: /repo/project
shell_cwd: /repo/project/packages/api
...
</SESSION_EXECUTION_CONTEXT>
```

When path facts are present, Yarn also includes a `<FILE_PATH_RESOLUTION>` section that tells models how client-native file tools resolve paths. The practical rule is:

- Use paths relative to `shell_cwd` when `shell_cwd` is set.
- Otherwise use paths relative to `project_root`.
- Do not prepend `project_root` or `shell_cwd` to a relative file path.
- Do not guess sibling checkout names or parent directories.

Yarn also uses session execution context for:

- Rehydrating workspace hints from persisted session metadata.
- Blocking or rewriting risky file and shell tool calls when path governance is enabled.
- Resolving project-bound MCP tool arguments.
- Adding git policy guidance when `SYNESIS_YARN_GIT_POLICY_MODE` is `advisory` or `enforced`.
- Optionally echoing path hints inside `<WORKING_FRAME>` for model continuity.

If no path facts are known and the client is recognized as a coder harness such as Claude Code, OpenCode, or Synesis ACP, Yarn adds `<PATH_HYGIENE>` instead. That fallback contains generic advice only; it does not prove where the user's files are.

## Client Integration Patterns

### ACP Bridge

The Synesis ACP bridge sends `POST /v1/chat/completions` with OpenAI-style body `metadata`.

It sets:

- `synesis_shell_cwd` from ACP `newSession.cwd`.
- `synesis_project_root` from `SYNESIS_PROJECT_ROOT`, trusted ACP `_meta`, the closest containing `additionalDirectories` entry, or `cwd`.
- `synesis_client_model_label` from ACP client information.
- Safe runtime and git hints from ACP `_meta`.

The bridge also uses the same metadata for ACP filesystem RPC path resolution.

### Claude Code

Claude Code hooks cannot add HTTP headers or request `metadata` to outbound `/v1/messages` calls. The maintained integration in [`clients/claude-code/`](../../clients/claude-code/) therefore uses two pieces:

- `synesis-context-hook.sh` writes `.claude/synesis-context.json` on `SessionStart` and `CwdChanged`.
- `synesis-anthropic-proxy.mjs` listens locally, reads that sidecar file, and merges the flat `synesis_*` keys into each request body.

The hook can add `additionalContext` to the transcript, but transcript text is not a substitute for request metadata. Metadata is what Yarn can parse before building adapter blocks, route enrichment, and path-governance decisions.

### Other Clients And Proxies

For OpenAI-compatible clients, add the flat fields to request body `metadata` at the adapter or reverse-proxy layer. For Anthropic-compatible clients, add request `metadata` when the SDK and endpoint preserve it; otherwise inject the fields in a local proxy before the request reaches Yarn.

Some upstream SDKs and gateways drop unknown provider fields. Verify that the request reaching Yarn still contains the metadata or headers.

## Examples

### OpenAI-Compatible Body

```json
{
  "model": "synesis-coder",
  "messages": [
    { "role": "user", "content": "Run the tests for the API package." }
  ],
  "metadata": {
    "synesis_project_root": "/Users/alex/src/shop",
    "synesis_shell_cwd": "/Users/alex/src/shop/packages/api",
    "synesis_runtime": {
      "platform": "darwin",
      "os_version": "macOS 15.5",
      "shell": "/bin/zsh"
    },
    "synesis_git_summary": "## main...origin/main [ahead 1]\n M packages/api/src/server.ts"
  }
}
```

### Anthropic-Compatible Body

```json
{
  "model": "synesis-coder",
  "max_tokens": 4096,
  "messages": [
    { "role": "user", "content": "Fix the failing route test." }
  ],
  "metadata": {
    "synesis_project_root": "/home/alex/work/synesis",
    "synesis_shell_cwd": "/home/alex/work/synesis/base/yarn-ts",
    "synesis_git_is_repo": true,
    "synesis_git_branch": "main",
    "synesis_git_dirty": true
  }
}
```

### Headers

```http
x-synesis-project-root: /home/alex/work/synesis
x-synesis-shell-cwd: /home/alex/work/synesis/base/yarn-ts
x-synesis-git-is-repo: true
x-synesis-git-branch: main
x-synesis-git-dirty: true
```

## Relevant Configuration

| Variable | Default | Effect |
|----------|---------|--------|
| `SYNESIS_YARN_SESSION_PATH_HINTS_IN_WORKING_FRAME` | `true` | Echoes `project_root` and `shell_cwd` inside `<WORKING_FRAME>` when present. |
| `SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE` | `true` | Constrains file-tool paths to the known project root or shell cwd. |
| `SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED` | `true` | Blocks duplicate-segment shell path drift patterns. |
| `SYNESIS_YARN_GIT_POLICY_MODE` | `advisory` | Adds git workflow guidance and can tighten guarded git tool behavior when set to `enforced`. |

## Troubleshooting

If Yarn ignores `shell_cwd`, confirm it is absolute and inside `synesis_project_root`.

If a client sends nested metadata and no context appears, switch to the flat `synesis_project_root` and `synesis_shell_cwd` keys.

If the model still duplicates workspace paths, inspect the actual request that reaches Yarn. The most common cause is a proxy or SDK dropping `metadata`.

If Yarn blocks an absolute file path with `missing_workspace_context_absolute_path`, send explicit metadata or headers. Prior tool evidence can help later turns, but it is not a reliable substitute for a client-supplied workspace root.

If Claude Code shows only transcript-level additional context, make sure the local proxy is running and that `.claude/synesis-context.json` is being merged into the HTTP request body.
