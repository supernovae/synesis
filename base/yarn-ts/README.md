# Synesis Yarn TS

Node 22 TypeScript orchestration service prototype for replacing Python Yarn.

## Design Highlights

- Vercel AI SDK Core (`ai`) as direct dependency.
- `customProvider` mapping for Synesis tiers to admin-owned provider/model assignments.
- Zod-validated API contracts.
- Sawtooth context manager with consolidation and log masking.
- Repeat-loop hard pivot guard.

## Regression checks (policy + image parity)

- **Unit tests:** from repo root after `npm ci`: `npm test --workspace=base/yarn-ts` (covers deterministic policy, repeat-loop session scoping, etc.).
- **Same compile order as the production image:** `./scripts/verify-yarn-ts-build-parity.sh` (mirrors `base/yarn-ts/Containerfile`; catches missing workspace packages such as `@synesis/mcp-tools` before Docker).

## Run Locally

```bash
npm install
npm run dev
```

The service listens on `0.0.0.0:8000` by default.

## Live verification (deployed Yarn)

From this directory, `npm run verify:live` hits a running Yarn OpenAI-compatible API. Prefer the same names as GitHub Actions:

- **`SYNESIS_YARN_EVAL_URL`** — public Yarn base URL (e.g. `https://coder.kybern.dev`; alias: `SYNESIS_YARN_URL`)
- **`SYNESIS_TEST_PAT_TOKEN`** — PAT for user-space `/v1` (CI; locally use `SYNESIS_TEST_AUTH` / `SYNESIS_TEST_TOKEN`)

The runtime **`SYNESIS_INTERNAL_SERVICE_TOKEN`** in this package is the **service** token Yarn uses to call the planner and other internals — not the PAT you pass to live-verify.

See **`docs/CI_GITHUB_VALIDATION.md`** and **`docs/LIVE_VERIFICATION_M9.md`**. Workflow: **`yarn-live-verify.yml`**.

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
- `SYNESIS_YARN_RESPONSE_STYLE_MODE` (default `guidance`) — markdown style policy mode: `off`, `guidance`, or `guardrail`.
- `SYNESIS_YARN_RESPONSE_STYLE_ALLOW_MERMAID` (default `true`) — whether style guidance should encourage mermaid diagrams when appropriate.
- Synthetic workspace handshake is disabled in fix-forward strict mode; provide `project_root` / `shell_cwd` through headers or request metadata for deterministic path anchoring.

## Current Scope

This is the first implementation pass focused on:

- protocol skeleton,
- provider tier polling and resolution,
- sawtooth core primitives,
- safety middleware hooks.

Advanced parity features (full MCP parity, persistence parity, and full streaming/tool lifecycle parity) are targeted in subsequent phases.
