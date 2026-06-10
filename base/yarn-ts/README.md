# Synesis Yarn TS

Node 22 TypeScript orchestration service prototype for replacing Python Yarn.

## Design Highlights

- Vercel AI SDK Core (`ai`) as direct dependency; OpenAI/Claude/ACP compliant surfaces for Cursor, Claude Code, Roo, VSCode, Zed, etc.
- Qwen3CoderAdapter (now supports qwen3-coder-next) with enhanced Plan→Do→Act workflow discipline, explicit phases/modes (Roo/Cursor inspired), self-verification, task tracking — reduces stalls and governor interventions.
- Deterministic execution governor (tool-event phases: explore/edit/verify/report/finalize) + phase policy for required tools and repair paths.
- Stable prefix, sawtooth compaction, artifact/server-side tools, transcript pruning for coherent long-context "edit/read/write/complete".
- Zod-validated contracts, Redis session store, MCP HTTP bridge.

**Prefix cache, provider shims, Redis artifact/tool tiers:** [docs/CACHING.md](docs/CACHING.md) (maintained in lockstep with [provider-cache-hints.ts](src/context/provider-cache-hints.ts) and related code).

Sensemaking safety: `SYNESIS_YARN_SENSEMAKING_ENABLED` runs classification/telemetry, while `SYNESIS_YARN_SENSEMAKING_PROMPT_BLOCK_ENABLED` separately controls prompt mutation (`<EXPLORATION_PLAN>` injection).

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

See **`docs/development/CI_GITHUB_VALIDATION.md`** and **`docs/development/TESTING.md`**. Workflow: **`yarn-live-verify.yml`**.

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
- `SYNESIS_YARN_CONTEXT_ADMISSION_WARN_TOKENS` (default `200000`) — warning threshold for estimated prompt+tool-schema input size.
- `SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS` (default `262000`) — hard reject threshold for clearly unsafe outbound context size.
- `SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED` — inject `synesis_knowledge_search` and `search_developer_docs` on non-streaming OpenAI-style requests (calls planner `POST /v1/knowledge/search`).
- `SYNESIS_YARN_WEB_SEARCH_ENABLED` — inject `synesis_web_search` similarly (planner-backed web; `fetch_pages` is token-heavy).
- `SYNESIS_YARN_RESPONSE_STYLE_MODE` (default `guidance`) — markdown style policy mode: `off`, `guidance`, or `guardrail`.
- `SYNESIS_YARN_RESPONSE_STYLE_ALLOW_MERMAID` (default `true`) — whether style guidance should encourage mermaid diagrams when appropriate.
- Token accounting: Shared `@synesis/telemetry/extractUsage` (strengthened for vLLM `cache_hit_tokens`, `prefix_cache_hit_tokens`, etc.). Admin UI no longer double-counts cached tokens in "Tokens" column. DashScope explicit cache markers are provider-scoped and gated by `SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MODE`; vLLM/OpenRouter-style routes continue to rely on stable prefix ordering and provider usage telemetry. See `usage-extract.ts`, `synesis-provider.ts`, `provider-cache-hints.ts`.
- `SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MODE` (default `off`) — `off|canary|auto`; enables DashScope `cache_control` markers only for DashScope endpoint URLs.
- `SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_CANARY_PCT` (default `10`) — deterministic session-hash canary percentage when mode is `canary`.
- `SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MAX_MARKERS` (default `3`) — marker cap passed to the prefix optimizer and DashScope endpoint adapter.

## OpenAI and Claude: model reasoning (thinking)

Yarn forwards **extended thinking** from the model to each client in the shape that protocol expects:

| Route | Client examples | How reasoning is exposed |
|-------|------------------|-------------------------|
| `POST /v1/messages` | Claude Code, Anthropic API clients | Streaming SSE: `thinking` / `thinking_delta` content blocks (see `docs/clients/CLAUDECODE.md`). Non-stream: `thinking` in assembled message content when present. |
| `POST /v1/chat/completions` | Cursor, OpenAI-style agents, `curl` | **Stream:** `choices[].delta.reasoning_content` (OpenAI-compatible extension; separate from `content`). **Non-stream:** `choices[0].message.reasoning_content` when the Vercel AI result includes `reasoning`. |

**Request side:** Bodies may include **`enable_thinking`** (OpenAI schema); Anthropic requests may include **`thinking`** and **`enable_thinking`**. Admin tier **sampling defaults** can set `enable_thinking` for thinking-capable backends (for example Qwen3 or DeepSeek-class models). **`DeepSeekAdapter`** adds `reasoningParser: "deepseek_r1"` so R1-style tags parse into stream parts.

**ACP:** The stdio bridge `synesis-yarn-acp` calls OpenAI with **`stream: false`**. It optionally sends **`enable_thinking`** via env, parses **`reasoning_content`** from the JSON response, and can prefix the ACP transcript — see `docs/clients/ACP_SYNESIS.md`.

## Admin Prompt Library: `model_family` (Kimi, MiniMax, etc.)

1. In Admin, use **`model_family` → slug** (e.g. `kimi`, `minimax`) on the picklist; see `base/admin/frontend/src/constants/promptModelFamilies.ts`.
2. Coder matches **`model_family`** to the **backend model id** on the role’s tier (from Model Registry) via `inferModelFamily()` in `src/prompt/infer-model-family.ts` — e.g. a model string containing `kimi` or `moonshot` → `kimi`, `minimax` or `abab` → `minimax`.
3. **Kimi backends** use `KimiAdapter` (path/CWD rails, loop steering, strict tool args). Force it on any provider via Model Registry **adapter hint = `kimi`** even when the model id is opaque. See [`docs/coder/KIMI_ADAPTER.md`](../../docs/coder/KIMI_ADAPTER.md).
4. **Validation:** `npm run test -- tests/infer-model-family.test.ts tests/stable-prefix.test.ts` — unit tests assert slug inference and that `StablePrefixService` includes Kimi/MiniMax overlays when `promptContext.modelFamily` matches. Telemetry and diagnostics can include `promptProfileIds` / `promptProfileHashes` on each completion path when you need to confirm at runtime.
5. **Long sessions — re-injecting the system block:** Yarn keeps **default + tier + `model_family` + role** overlays in the **stable prefix** (session-scoped, cache-friendly) on each request, not only on turn 1. You do not need a separate “refresh system prompt” timer: the same logical instructions are re-attached for each upstream call. Per-request duplication of a *huge* custom profile still costs tokens; prefer **sawtooth compaction** and transcript pruning for context growth instead of appending the full system text again in the *middle* of the message list (which would be an anti-pattern for prefix-cache alignment and is not how Yarn is structured). If a product requirement needs *periodic* behavioral nudges in long threads, a short **governor- or user-turn reminder** in conversation is more typical than re-sending the entire base system block mid-history.

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
