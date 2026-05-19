# opencode Compatibility Workarounds

## Status: Temporary — track upstream resolution

We added several Yarn API workarounds to support [opencode](https://github.com/sst/opencode)
as a client. These compensate for behaviors in opencode's conversation
replay and tool-call serialization that diverge from the OpenAI chat
completions spec. **These workarounds may not be desirable long-term** and
should be revisited once the upstream issues are resolved.

### GitHub issue to track

> **TODO:** link the opencode GitHub issue here once filed / found.

When the upstream fix lands, audit each workaround below and remove the
ones that are no longer necessary.

---

## Workarounds applied

### 1. Reconstruct missing `tool_calls` on replayed assistant messages

**Commit:** `e48a5d44` — *reconstruct missing tool_calls for clients that strip them*

opencode replays conversation history without `tool_calls` on assistant
messages. This causes `healToolCallResultPairs` to treat every tool result
as orphaned and strip it, leaving the model with zero tool history and
triggering infinite loops.

`reconstructMissingToolCalls` walks backwards from each tool result to the
nearest preceding assistant message and grafts synthetic `tool_calls`
entries to restore conversation structure before normalization.

**Files:** `base/yarn-ts/src/index.ts`, `base/yarn-ts/src/tool-mapping.ts`

### 2. camelCase → snake_case argument normalization (round-trip safe)

**Commits:** `2dce50c0`, `90fe1b04`

opencode sends tool arguments in camelCase (`filePath`, `oldString`,
`newString`) while our governance pipeline expects snake_case (`file_path`,
`old_string`, `new_string`). Without normalization every Read/Write/Edit
call is rejected on the first attempt.

The normalization converts to snake_case internally for validation and
path-checking, then restores the original camelCase keys before returning
so opencode's client-side schema validation still passes.

**Files:** `base/yarn-ts/src/path-governance/tool-call-governance.ts`,
`base/yarn-ts/src/providers/model-adapter.ts`

### 3. Drop empty assistant messages

**Commit:** `32aeb687`

opencode can send assistant messages with no content and no `tool_calls`.
Strict providers (Kimi, MiniMax) reject these. We now skip them during
OAI-to-ModelMessage conversion instead of synthesizing a placeholder.

**File:** `base/yarn-ts/src/tool-mapping.ts`

### 4. Extract project root and CWD from opencode system prompt

opencode embeds environment metadata in the system message rather than
HTTP headers or body `metadata`:

```
Working directory: /Users/dev/projects/my-app/packages/api
Workspace root folder: /Users/dev/projects/my-app
Is directory a git repo: yes
Platform: darwin
Today's date: Thu Apr 24 2026
```

Our metadata extractor (`extractLoosePatterns`) now recognizes these
patterns in addition to the Cursor/Claude Code `<user_info>` format:

| opencode pattern | Maps to |
|------------------|---------|
| `Working directory:` | `shellCwd` |
| `Workspace root folder:` | `workspacePath` → `projectRoot` |
| `Platform:` | `platform` (when `OS Version:` is absent) |

This allows path governance and the path sandbox to anchor correctly,
preventing the model from referencing random directories outside the
project.

OpenCode's client-side file tools resolve relative paths from `Working
directory`. `Workspace root folder` is kept as the broader repository/workspace
boundary for context and sandboxing. When both are present and differ, Yarn
normalizes returned `Read`/`Write`/`Edit` tool paths to be relative to
`Working directory` so paths like `k8/overseerr/overseerr-k8s.yaml` do not get
executed as `/home/byron/k8/overseerr/k8/overseerr/overseerr-k8s.yaml`.

**File:** `base/yarn-ts/src/providers/prefix-optimizer/metadata-extractor.ts`

> **Note:** This is a **keep** — not a temporary workaround. opencode's
> system prompt format is its stable contract. The other workarounds above
> (tool_calls reconstruction, camelCase normalization) are the ones that
> should be audited against upstream fixes.

---

## Diagnostic commits (can be removed)

The following commits added temporary diagnostics during the investigation
and can be cleaned up at any time:

| Commit | Purpose |
|--------|---------|
| `5ef71c5f` | Raw message shape diagnostic |
| `9d347bee` | `heal_tool_pairs_diagnostic` tracing |
| `0a908b6d` | Tool-call pair integrity & scope analysis logging |
