# Synesis Yarn TS

Node 22 TypeScript orchestration service prototype for replacing Python Yarn.

## Design Highlights

- Vercel AI SDK Core (`ai`) as direct dependency.
- `customProvider` mapping for Synesis tiers to admin-owned provider/model assignments.
- Zod-validated API contracts.
- Sawtooth context manager with consolidation and log masking.
- Repeat-loop hard pivot guard.

## Run Locally

```bash
npm install
npm run dev
```

The service listens on `0.0.0.0:8000` by default.

## Important Environment Variables

- `SYNESIS_YARN_ADMIN_API_URL`
- `SYNESIS_INTERNAL_SERVICE_TOKEN`
- `SYNESIS_YARN_DEFAULT_TIER`
- `SYNESIS_YARN_TIER_POLL_INTERVAL`
- `SYNESIS_YARN_OPENAI_COMPAT_BASE_URL`
- `SYNESIS_YARN_OPENAI_COMPAT_API_KEY`
- `SYNESIS_YARN_SESSION_PATH_HINTS_IN_WORKING_FRAME` (default `true`) — include client `project_root` / `shell_cwd` in `<WORKING_FRAME>` when sent; see `docs/clients/SESSION_EXECUTION_CONTEXT.md`.
- `SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE` (default `true`) — clamp file-tool paths to `project_root` (or `shell_cwd` fallback) across coder routes.
- `SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED` (default `true`) — block risky `mkdir && cd` duplicate-segment drift by rewriting the Bash tool call to a safe failure.
- `SYNESIS_YARN_WORKSPACE_CONTEXT_HANDSHAKE_ENABLED` (default `false`, enabled via `deploy.sh`) — on first turn with missing path hints, emit a transparent read-only `Bash` tool call to initialize workspace context (`cwd`, `project_root`, `shell`, `os`).
- `SYNESIS_YARN_WORKSPACE_CONTEXT_HANDSHAKE_MAX_ATTEMPTS` (default `1`) — maximum synthetic handshake retries per session.

## Current Scope

This is the first implementation pass focused on:

- protocol skeleton,
- provider tier polling and resolution,
- sawtooth core primitives,
- safety middleware hooks.

Advanced parity features (full MCP parity, persistence parity, and full streaming/tool lifecycle parity) are targeted in subsequent phases.
