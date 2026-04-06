# Git-First Policy Modes

This document defines how Git-first behavior is steered across Synesis Yarn prompt context, shim/session interfaces, and Yarn MCP tools.

## Policy modes

`SYNESIS_YARN_GIT_POLICY_MODE` supports:

- `off`: no Git-first steering in session policy text; guarded Git tools still perform minimal safety checks.
- `advisory` (default): repo-aware context and workflow nudges are injected, but normal user workflows remain unblocked.
- `enforced`: guarded Git mutation tools apply stricter preflight checks and refuse risky commit flows.

## Control surfaces

| Surface | What is steered |
|--------|------------------|
| Session execution context (`<SESSION_EXECUTION_CONTEXT>`) | Adds `git_policy_mode`, structured git facts, and explicit repo/non-repo guidance. |
| Client adapter workflow text | Encourages status/diff checkpoints and commit hygiene in repositories. |
| Yarn MCP read-only git tools | `git_rev_parse`, `git_branch_info`, `git_file_state` provide deterministic repository state for models. |
| Yarn MCP guarded git mutation tools | `git_add_guarded` and `git_commit_guarded` enforce sensitive-path blocklists and preflight checks; stricter behavior under `enforced`. |
| Governance telemetry | Distinguishes path-drift blocks, unsafe shell blocks, and strict write-capable tool blocks for measurable rollout decisions. |

## Shim/interface contract

Preferred metadata/header inputs for repository state:

- `synesis_git_is_repo` / `x-synesis-git-is-repo`
- `synesis_git_branch` / `x-synesis-git-branch`
- `synesis_git_dirty` / `x-synesis-git-dirty`
- `synesis_git_has_untracked` / `x-synesis-git-has-untracked`
- `synesis_git_ahead` / `x-synesis-git-ahead`
- `synesis_git_behind` / `x-synesis-git-behind`
- optional fallback: `synesis_git_summary`

If only `synesis_git_summary` is provided, Yarn performs best-effort parsing of branch/ahead/behind/dirty flags.

## Rollout norm

1. Start tenants on `advisory`.
2. Measure KPIs and false-positive rates.
3. Promote selected tenants to `enforced` when quality and stall metrics stay within target.
4. Keep `off` as rollback mode.
