# Kimi adapter (Yarn `KimiAdapter`)

Yarn routes Kimi / Moonshot / Kimi K2.x backends through a dedicated **`KimiAdapter`** (`base/yarn-ts/src/providers/model-adapter.ts`) instead of a generic OpenAI shim. Use it for **any provider** that serves Kimi models (Moonshot API, Kimi Code, OpenRouter, vLLM, LiteLLM passthrough, etc.).

## When it applies

| Mechanism | Behavior |
|-----------|----------|
| **Auto-detect** | Backend model id matches `kimi`, `moonshot`, `k2.5`, `k2.6`, or `k2.7` (case-insensitive). |
| **Admin override** | Model Registry → deployment → **Adapter hint** = `kimi` (forces adapter even if the model string is opaque, e.g. `synesis-coder`). |
| **Prompt Library** | `model_family` = `kimi` overlays still apply via `inferModelFamily()` — independent of adapter hint but should stay aligned. |

Auto-detect regex (yarn): `/kimi|moonshot|k2[.-]?[567]/i`

## What the adapter does

### 1. Tool system prompt (K2.x “isms”)

Injected when the client offers tools. Covers:

- **Client-native paths** — Read/Write/Edit resolve from `shell_cwd` / `project_root` in `<SESSION_EXECUTION_CONTEXT>`; no UI path prefix duplication (the OpenCode `k8/overseerr/...` failure mode).
- **Strict tool schema** — exact `file_path`, `command`, `{}` for empty args; no empty assistant turns.
- **Read vs Bash** — prefer Read over `cat`/`sed` on guessed paths.
- **WebFetch** — one fetch per URL per task unless the user asks to refresh.
- **Long agent sessions** — plan → act; avoid re-gathering the same context (K2.x agent / swarm style loops).

Also includes shared **Plan → Do → Act** discipline (`SHARED_CLAUDE_CODE_WORKFLOW_DISCIPLINE`).

### 2. Argument normalization

- `normalizeToolCallArgs` — empty / `null` → `{}` (strict providers reject missing args).
- `remapToolArgs` — `path` → `file_path`, `cmd` → `command`, etc. (same alias table as Qwen).

### 3. Tool description hints

Per-tool suffixes on Read, Write, Edit, Bash, WebFetch, Grep, Glob (visible in the tool schema the model sees).

### 4. Loop steering (same pipeline as Qwen)

`KimiAdapter` is in `TOOL_LOOP_STEERING_FAMILIES`. Yarn runs:

- `getEarlyPivotPrompt` — Kimi-specific checks **first**, then Qwen delegate:
  - Path-not-found after repeated Reads
  - Repeated WebFetch to the same URL
  - Long prose plan without tools
  - (delegate) read loops, edit retries, git introspection, plan-without-action, …
- `dampenConsecutiveSameTools` — WebFetch streaks + Qwen dampening for Read/Grep/Bash/Task tools
- `detectQwenLoopRisk` — write-tool prioritization when loop risk is high

Config knobs (shared with Qwen today): `SYNESIS_YARN_QWEN_STAGNATION_*`, `SYNESIS_YARN_QWEN_PLAN_NO_ACTION_LIMIT`, `SYNESIS_YARN_QWEN_EDIT_RETRY_LIMIT`.

### 5. Default sampling (fallback only)

`temperature: 1.0`, `top_p: 0.95` when the client omits sampling — aligned with Moonshot's Kimi K2.x thinking-mode guidance. **Client and Admin tier values still win** when set.

### 6. Thinking / reasoning

`supportsThinking: true` — Kimi K2.x may return `reasoning_content`; Yarn’s OpenAI path can surface it when the upstream API does. No separate `reasoningParser` today (unlike DeepSeek R1).

Kimi K2.7 Code is still treated as the same generic `kimi` adapter/preset family because the model card states that it keeps the K2.5/K2.6 architecture and deployment path. The important K2.7 operational differences are:

- thinking mode is forced by the provider/model;
- `preserve_thinking` is forced and cannot be disabled;
- instant mode is not supported;
- the model card reports about 30% lower thinking-token usage versus K2.6, so do not add synthetic thinking budget inflation just for K2.7.

Synesis therefore does **not** add a separate `kimi_k2_7` preset. Use the existing `adapter_hint=kimi` and `model_capability_preset=kimi_k2`. Aliases such as `kimi-k2.7` and `kimi-k2.7-code` normalize to `kimi_k2` for public offerings.

## Operator setup

### Model Registry (recommended for opaque model names)

1. Admin → **Models** → edit the role deployment.
2. Set **Adapter hint** to **Kimi / Moonshot**.
3. Set **Model capability preset** to **Kimi K2** when the model id is opaque.
4. Save and reconcile LiteLLM if used.

For Kimi K2.7 Code, a good starting point is:

```json
{
  "model": "moonshotai/Kimi-K2.7-Code",
  "adapter_hint": "kimi",
  "route_params": {
    "model_capability_preset": "kimi_k2",
    "temperature": 1.0,
    "top_p": 0.95,
    "enable_thinking": true,
    "default_context_mediation_mode": "adaptive"
  },
  "context_window": 256000
}
```

Do not configure `enable_thinking: false` for K2.7. The model card says thinking/preserve-thinking are forced, so disabling it in Synesis only creates misleading local configuration.

### Prompt Library (optional overlays)

1. Admin → **Prompt Library** → assignment `target_type=model_family`, `target_value=kimi`.
2. Use for org-specific tone or extra rails; avoid duplicating path rules already in `KimiAdapter`.

### OpenCode / harness metadata (best path reliability)

Send every turn (in addition to adapter behavior):

```json
{
  "synesis_project_root": "/home/user/k8",
  "synesis_shell_cwd": "/home/user/k8/overseerr"
}
```

Or headers `x-synesis-project-root` / `x-synesis-shell-cwd`. See [`opencode-compat.md`](opencode-compat.md).

### Kimi Code API

Endpoint transport: `kimi_coding` sets the required `User-Agent` for `https://api.kimi.com/coding/v1`. Adapter hint `kimi` is still recommended for loop steering and path prompts.

## Path governance interaction

Yarn **still** repairs doubled cwd segments in `governToolCall` when `shell_cwd` is known (see path-governance tests). The Kimi adapter teaches the model; governance rewrites bad tool args before OpenCode executes them.

Ensure `shell_cwd` is present via metadata, session persistence, or OpenCode system prompt extraction (including `Working directory:` outside `<user_info>`).

## Verification

```bash
cd base/yarn-ts
npm test -- tests/model-adapter.test.ts tests/infer-model-family.test.ts
```

Runtime: check Yarn logs for `adapter_pivot_*` events with `family: "kimi"` on long sessions.

## Related docs

- [`opencode-compat.md`](opencode-compat.md) — OpenCode cwd / camelCase / tool_calls workarounds
- [`OPENAI_TEST_HARNESSES.md`](OPENAI_TEST_HARNESSES.md) — `--cwd` metadata for harness runs
- [`base/yarn-ts/README.md`](../../base/yarn-ts/README.md) — `model_family` + Admin Prompt Library
