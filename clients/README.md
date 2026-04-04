# Client integrations (copyable assets)

This directory holds **runnable or copy-pasteable** integrations for Synesis: hooks, small proxies, settings snippets, and future IDE/CLI add-ons.

**Documentation** (guides, contracts, troubleshooting) lives under [`docs/clients/`](../docs/clients/), not here, so scripts stay easy to find and GitHub raw URLs stay short.

## Contents

| Path | Description |
|------|-------------|
| [`claude-code/`](claude-code/) | Claude Code hooks + optional local Anthropic proxy for Yarn session context (`project_root`, `cwd`, runtime). |

Add new subfolders under `clients/` as you ship more client-specific tooling.
