# Synesis Yarn TS

Node 22 TypeScript orchestration service prototype for replacing Python Yarn.

## Design Highlights

- Vercel AI SDK Core (`ai`) as direct dependency.
- `customProvider` mapping for Synesis tiers to admin-owned provider/model assignments.
- Zod-validated API contracts.
- Sawtooth context manager with consolidation and log masking.
- Repeat-loop hard pivot guard.

## Regression checks (policy + image parity)

- **Unit tests:** from repo root after `npm ci`: `npm test --workspace=base/yarn-ts` — includes `tests/deterministic-policy-engine.test.ts` (repeat-loop **sessionKey** scoping), `tests/containerfile-build-parity.test.ts` (Containerfile must build every `@synesis/*` dependency), and the rest of the suite.
- **Same compile order as the production image:** `./scripts/verify-yarn-ts-build-parity.sh` (mirrors `base/yarn-ts/Containerfile`; catches missing workspace packages before Docker).
- **ESLint:** not wired for this package; contract tests above cover Dockerfile drift and policy invariants without a custom ESLint plugin.

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

See **`docs/development/CI_GITHUB_VALIDATION.md`** and **`docs/development/LIVE_VERIFICATION_M9.md`**. Workflow: **`yarn-live-verify.yml`**.

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
- `SYNESIS_YARN_GIT_POLICY_MODE` (default `advisory`) — `off|advisory|enforced` repo behavior mode for prompt context and guarded git MCP preflights.
- `SYNESIS_YARN_CONTEXT_ADMISSION_MODE` (default `hybrid`) — outbound prompt admission behavior: `advisory|hybrid|enforced`.
- `SYNESIS_YARN_CONTEXT_ADMISSION_WARN_TOKENS` (default `120000`) — warning threshold for estimated prompt+tool-schema input size.
- `SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS` (default `180000`) — hard reject threshold for clearly unsafe outbound context size.
- `SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED` — inject `synesis_knowledge_search` and `search_developer_docs` on non-streaming OpenAI-style requests (calls planner `POST /v1/knowledge/search`).
- `SYNESIS_YARN_WEB_SEARCH_ENABLED` — inject `synesis_web_search` similarly (planner-backed web; `fetch_pages` is token-heavy).
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

## Knowledge catalog vs web search

Yarn nudges the model (tool descriptions, optional system fragment when retrieval tools are present, tool-schema pruning priority) to prefer **knowledge** tools before **web**, and to avoid full-page fetch until snippets fail. Retrieval is still **optional** — nothing runs on every turn.

Those tools only return useful results if the **indexer** has ingested relevant material (e.g. Cobra/spf13 patterns, kubectl snippets). Yarn does not ingest documents; operators curate the corpus and metadata (language, `scope_tags`, etc.) separately.
