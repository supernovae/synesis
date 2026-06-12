# Budget, Limits & Temperature Reference

Single-source reference for all token budgets, context limits, and temperature
settings across the Synesis pipeline. Use this when tuning throughput, diagnosing
truncation, or auditing model behavior.

Last updated: 2026-06-10

---

## Token Budget Scaling

Budgets scale with **difficulty** (0.0–1.0, set by the entry classifier). The
formula is always `base + difficulty × (max − base)` unless noted.

### planner-ts (`base/planner-ts`)

Pure scaling lives in [`base/planner-ts/src/budgets.ts`](../base/planner-ts/src/budgets.ts); defaults are loaded via [`loadConfig`](../base/planner-ts/src/config.ts) (`SYNESIS_PLANNER_TS_*`). The entry classifier applies **tier ceilings** from [`model-tiers.ts`](../base/planner-ts/src/model-tiers.ts): `min(scaled_budget, tier.writerMaxTokens)` (and likewise for critic) so named tiers can cap output below the global curve.

| Setting (env) | Default | Notes |
|---|---|---|
| `SYNESIS_PLANNER_TS_TRIVIAL_WRITER_BUDGET` | 2,048 | Trivial fast-path writer |
| `SYNESIS_PLANNER_TS_WRITER_BUDGET_BASE` | 2,048 | Scaled writer at difficulty 0 |
| `SYNESIS_PLANNER_TS_WRITER_BUDGET_MAX` | 32,768 | Scaled writer at difficulty 1 (before tier clamp) |
| `SYNESIS_PLANNER_TS_CRITIC_BUDGET_BASE` | 800 | Critic linear scale |
| `SYNESIS_PLANNER_TS_CRITIC_BUDGET_MAX` | 4,000 | Critic scale endpoint before global clamp |
| `SYNESIS_PLANNER_TS_CRITIC_MAX_TOKENS` | 4,096 | Hard ceiling on critic `max_tokens` |
| `SYNESIS_PLANNER_TS_PLANNER_MAX_TOKENS` | 4,096 | LLM JSON plan output (base; adaptive scaling may raise) |
| `SYNESIS_PLANNER_TS_LLM_TIMEOUT_MS` | 300,000 | LLM HTTP timeout (ms) |

Writer scaling: `scaled_writer_budget(d) = 2048 + d × (32768 − 2048)`,
unless the task is classified as trivial, in which case
`SYNESIS_PLANNER_TS_TRIVIAL_WRITER_BUDGET` is used.

### Adaptive planner budget

The planner's `max_tokens` scales adaptively based on task signals to prevent
JSON truncation on complex prompts while keeping simple tasks efficient.

| Condition | Budget boost | Cumulative example |
|---|---|---|
| Base | 4,096 | 4,096 |
| `difficulty >= 0.7` | +800 | 4,896 |
| `cynefin_domain` ∈ {complex, chaotic} | +800 | 5,696 |
| `difficulty >= 0.85` | +400 | 6,096 |
| **Hard ceiling** | **8,192** | — |

Implemented in `computeAdaptivePlannerCap()` in
[`llm-planner.ts`](../base/planner-ts/src/nodes/llm-planner.ts). The effective
cap (not the static env default) is reported in planner span `budgetSpanMetadata`
so traces accurately reflect what was sent to the LLM.

**Why:** A complex architecture prompt classified as `chaotic` with difficulty
0.92 previously hit 98.9% budget utilization with a smaller cap, truncating JSON
mid-object. The adaptive cap gives hard tasks extra room while still bounding
latency.

**Trace metadata** (see [`pipeline.ts`](../base/planner-ts/src/pipeline.ts), [`budgets.ts`](../base/planner-ts/src/budgets.ts) `budgetSpanMetadata`):

Every LLM-calling span (`writer`, `critic`, `planner`) emits a uniform set of budget fields via `budgetSpanMetadata(maxOutputTokens, usage)`:

| Field | Type | Description |
|---|---|---|
| `max_output_tokens` | `number` | Generation cap sent to the LLM for this span |
| `prompt_tokens` | `number` | Prompt tokens consumed (from usage) |
| `completion_tokens` | `number` | Completion tokens generated |
| `total_tokens` | `number` | Total tokens (prompt + completion) |
| `budget_utilization` | `number?` | `completion_tokens / max_output_tokens` (omitted when cap is 0) |

Additionally, `entry_pipeline` records `writer_max_tokens`, `critic_max_tokens`, `difficulty`, `task_is_trivial`, and `model_tier` so resolved caps are visible immediately after classification.

Use `budget_utilization` to detect under-use (wasted headroom) or near-saturation (possible truncation). Filter spans with `jq '.metadata.budget_utilization > 0.9'` to find truncation-risk calls.

**Provider routes:** Each request’s effective generation limit is the minimum of the planner node budget, the role assignment's configured `max_tokens`, and the upstream provider limit.

Planner ontology and taxonomy YAML assets live in `base/planner-ts/config/`; runtime budget behavior is implemented in `base/planner-ts/src/`.

### Section Workers

| Setting | Value | File |
|---|---|---|
| `section_budget_base` | 1,024 | `config.py` |
| `section_budget_max` | 8,192 | `config.py` |

### Evidence

| Setting | Value | File |
|---|---|---|
| `evidence_budget_chars` | 24,000 chars | `config.py` |
| `evidence_budget_chars_max` | 60,000 chars | `config.py` |

Evidence is measured in characters (not tokens). The writer applies a safety
guard: `max_evidence = (compiler_model_context × 4) − (writer_budget_max × 4) − 8000`
to prevent evidence from starving the output budget.

---

## Context Window Limits

| Setting | Value | File | Notes |
|---|---|---|---|
| `compiler_model_context` | 131,072 | `config.py` | Safe for OpenRouter and Qwen3 (128K native) |
| `curator_max_total_tokens` | 8,192 | `config.py` | Hard cap on Worker prompt context |

---

## Role Route Defaults — max_tokens

Model role assignments in the admin Model Registry can include route-level defaults. These defaults are merged into planner/Yarn requests unless a node supplies a more specific value.

| Role | Typical max_tokens | Role |
|---|---:|---|
| `router` | 4,096 | Classification, planning, advisor |
| `planner` | 4,096 | Structured planning |
| `critic` | 4,096 | Evaluation, scoring |
| `writer` | 32,768 | Writer, synthesis |
| `coder` | 16,384 | IDE direct agentic coding |
| `summarizer` | 2,048 | History compression |

---

## Temperature Settings

Temperatures are set at **two levels**: role route defaults in the admin Model Registry and planner node overrides for pipeline calls.

### Planner-ts code — per-node temperatures

| Module / Context | Model Role | Temperature | Rationale |
|---|---|---:|---|
| `src/nodes/entry-classifier.ts` | Router | deterministic | YAML/BM25 classification and budget selection do not call the LLM |
| `src/nodes/frame-extractor.ts` — LLM segmentation | Writer | `0.0` | Structured task-frame extraction |
| `src/nodes/llm-planner.ts` — ambiguity scorer | Router | `0.0` | Deterministic clarification scoring |
| `src/nodes/llm-planner.ts` — plan decomposition | Planner | `0.0` | Reproducible JSON plans |
| `src/nodes/router.ts` | Router | deterministic | Retrieval routing, cohesion, and evidence assembly happen in code |
| `src/nodes/critic-evaluator.ts` | Critic | `0.0` | Consistent JSON critique with deterministic fallback |
| `src/nodes/writer-compose.ts` | Writer | `generation.temperature ?? 0.2` | Admin model offerings can override; otherwise writer calls use the safe default |

Writer and critic output budgets are scaled in
`src/nodes/entry-classifier.ts` from task difficulty and clamped by
`src/model-tiers.ts` plus `SYNESIS_PLANNER_TS_*_BUDGET_*` settings in
`src/config.ts`.

### Role route defaults — temperatures

These apply when a role assignment provides a default and the caller does not supply a node-specific override.

| Model | Temperature | Role | Notes |
|---|---|---|---|
| `synesis-agent` | 0.2 | Pipeline entry | Planner manages internal temps |
| `synesis-router` | 0.1 | Classification | Low for deterministic routing |
| `synesis-critic` | 0.1 | Evaluation | Consistent scoring |
| `synesis-writer` | 0.3 | Writer | Balanced for synthesis |
| `synesis-coder` | 0.2 | Code generation | Precision for code |
| `synesis-thinking` | 0.2 | R1 thinking | R1-Distill's CoT adds its own diversity |
| `synesis-summarizer` | 0.1 | Compression | Faithful to source |

### Temperature guidelines by role

| Role | Range | Why |
|---|---|---|
| Routing / classification | 0.0–0.1 | JSON schema adherence, deterministic decisions |
| Plan decomposition | 0.0–0.1 | Reproducible task breakdowns |
| Evaluation / critic | 0.0–0.1 | Consistent quality scores |
| Summarization | 0.0–0.1 | Faithful compression, no hallucination |
| Code generation | 0.0–0.2 | Syntactic precision |
| Writer synthesis | 0.3–0.5 | Fluent prose while grounded in evidence |
| Thinking mode (Qwen3) | 0.6 | Per Qwen3 official recommendation for reasoning |
| Casual / trivial | 0.3–0.5 | Natural conversational tone |

---

## Other Pipeline Limits

| Setting | Value | File | Notes |
|---|---|---|---|
| `max_tokens_per_request` | 100,000 | `config.py` | Global hard ceiling |
| `max_executor_tokens` | 0 (disabled) | `config.py` | Per-node override (0 = use global) |
| `max_iterations` | 3 | `config.py` | Retry loop ceiling |
| `node_timeout_seconds` | 180 | `config.py` | Per-node LLM call timeout |
| `critic_max_tokens` | 4,096 | `config.py` | CriticOut budget |
| `frame_repair_max_tokens` | 1,024 | `config.py` | Frame extractor LLM repair |
| `router_max_summary_tokens` | 2,000 | `config.py` | Evidence packet summaries |
| `depth_mode_max_parallel` | 12 | `config.py` | Concurrent section workers |
| `crag_max_web_queries` | 8 | `config.py` | Web search ceiling per run |
| `max_cited_sources` | 5 | `config.py` | Sources shown in response |

---

## Inference Mode (Full vs Selective)

The `inference_mode` setting (`SYNESIS_INFERENCE_MODE` env var) controls how
aggressively the pipeline gates safeguards. Can also be overridden per-request
via the `X-Synesis-Inference-Mode` HTTP header.

| Threshold | Full | Selective | Effect |
|---|---|---|---|
| RAG disable below | 0.3 | 0.5 | More prompts skip retrieval |
| Frame repair above | 0.4 | 0.6 | Fewer LLM repair calls |
| Entry fast-path below | 0.3 | 0.5 | More prompts skip advisor + frame |
| Critic skip below | 0.15 | 0.3 | More prompts skip critic entirely |
| Critic lenient below | 0.4 | 0.6 | More prompts get fast lenient critic |
| Multi-query above | 0.3 | 0.5 | Fewer multi-query fan-outs |
| HyDE above | 0.5 | 0.7 | Fewer HyDE variant generations |

See `evals/README.md` for the A/B evaluation framework and acceptance gates.

---

## Where Limits Are Set

Quick lookup for where to change each type of limit:

| What to change | Primary file | Secondary file |
|---|---|---|
| Writer / critic / planner budgets | `base/planner-ts/src/config.ts` | `base/planner-ts/src/budgets.ts`, `model-tiers.ts` |
| Writer/evidence composition | `base/planner-ts/src/nodes/writer-compose.ts` | `base/planner-ts/src/retrieval/` |
| Role route `max_tokens` | Admin Model Registry | — |
| Temperature (pipeline nodes) | `base/planner-ts/src/nodes/*` | `base/planner-ts/src/graph.ts` |
| Temperature (role default) | Admin Model Registry | — |
| Context window / provider route limits | Admin Model Registry | `base/planner-ts/src/model-tiers.ts` |
| HTTP timeouts | `base/planner-ts/src/config.ts` | `base/planner-ts/src/llm/client.ts` |

---

## Yarn (fabric)

Yarn's token and tool budgets follow a similar philosophy to the planner — scale
with context, enforce via ledger — but substitute **interaction mode + client
preset** for task difficulty. Client execution context is documented in
[docs/clients/SESSION_EXECUTION_CONTEXT.md](clients/SESSION_EXECUTION_CONTEXT.md);
tool-output reduction and reducer runtime controls are documented in
[`base/yarn-ts/src/reduction/README.md`](../base/yarn-ts/src/reduction/README.md).

### Session budget & safety limits

| Setting | Default | Env var | Notes |
|---|---|---|---|
| Session max input tokens | 2,000,000 | `SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS` | Cumulative input tokens per session key |
| Consecutive tool calls (hard) | 15 | `SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT` | Circuit breaker — rejects request |
| Consecutive tool calls (pivot) | 10 | `SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT` | Soft pivot — injects "stop and explain" prompt |
| Hard reject after N repeats | 6 | `SYNESIS_YARN_POLICY_HARD_REJECT_AFTER` | Identical-action dedup |
| Inactivity rotation threshold | 30 min | `SYNESIS_YARN_SESSION_INACTIVITY_ROTATION_MS` | Auto-rotates session key when idle (see below) |

### Session lifecycle & inactivity rotation

Sessions are keyed as `synesis:{userId}:{clientKind}:{conversationId}`. Clients
that provide an explicit `conversation_id` (via body field, `metadata.session_id`,
or `x-synesis-conversation-id` / `x-claude-session-id` headers) get one session
per conversation.

**Problem:** Claude Code does not send a conversation ID. All requests from a
single user collapse into `synesis:{uid}:claude-code:_`, accumulating tokens
across logically unrelated conversations.

**Fix (shipped):** When no explicit conversation ID is present, yarn-ts uses an
active implicit session alias with a rotation suffix (`...:_:r{timestamp}`).
The alias is kept in Redis while the conversation is active. If Redis no longer
has an active alias/session, yarn-ts mints a new rotated key instead of reusing
the bare `synesis:{uid}:{client}:_` key, which prevents old Postgres usage rows
from being joined to a new local project.

Session records are stored in Redis (4-hour TTL, refreshed on each request) and
persisted to Postgres via the usage writer for the admin session viewer.

Cross-session continuity bootstrapping is opt-in via
`SYNESIS_YARN_SESSION_CARRY_FORWARD_BOOTSTRAP_ENABLED=true`. By default, a new
implicit session starts clean unless the client resumes with an explicit
conversation/session identifier.

### TODO: Context-aware session pivot (future)

The inactivity rotation handles the time-based case (user comes back after a
break), but misses the **context-shift** case — e.g., back-to-back projects in
the same sitting where the cached prefix from a Terraform session is dead weight
for a new Go project.

**Proposed approach:**

1. **Project manifest fingerprint** — the `ProjectManifestService` already
   detects project type (Go mod, package.json, Cargo.toml, etc.) per request.
   Hash the detected language, project root, and key files at session start.
2. **Divergence check** — on each request, recompute and compare. If the
   fingerprint diverges beyond a threshold, trigger a `session_context_pivot`
   rotation (same mechanism as inactivity rotation, different trigger).
3. **Signals available today:**
   - Working frame file extensions (`.tf` → `.go`)
   - Project manifest detected project type
   - Tool result file paths (language/framework indicators)
   - First user message ("new project", radically different domain)
4. **Cache-efficiency benefit** — rotating on context shift avoids paying
   full-price input tokens for a stale prefix that yields zero cache hits
   upstream. The new session starts with a clean prefix that the provider can
   cache effectively.

**Cost of the check:** Near-zero — manifest and working frame services already
run per-request. The fingerprint hash + comparison is O(1).

**Blocked on:** Nothing technical; this is a prioritization/scheduling item. The
rotation infrastructure (`getSessionKey` → `buildSessionKey` + async rotation
logic) is in place and extensible.
